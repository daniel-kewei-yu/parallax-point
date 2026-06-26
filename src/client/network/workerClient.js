/*
Author: Daniel Yu
Date: March 15, 2026
Description: Handles the client's connection to the physics SharedWorker. This module is responsible for
             establishing the worker connection, sending join/leave messages, and processing incoming messages
             from the worker. It updates the local game state (blocks, portals, local player, remote players)
             based on world_state broadcasts, handles portal teleport synchronisation, and manages session
             persistence (saving/restoring player state via sessionStorage). It also provides a clean exit
             on page unload.
*/

// Import the global game state singleton.
import { GameState } from '../clientState.js';
// Import the block manager to update block meshes from worker state.
import { updateBlocks } from '../mechanics/blockManager.js';
// Import the remote player manager to update remote avatars.
import { RemotePlayerManager } from '../players/RemotePlayerManager.js';
// Import the portal manager to update portal meshes.
import { PortalManager } from '../mechanics/portalMechanics/PortalManager.js';
// Import the portal proxy manager (used indirectly, but needed for initialisation).
import { PortalProxyManager } from '../mechanics/portalMechanics/PortalProxyManager.js';
// Import the portal interaction manager (used indirectly).
import { PortalInteraction } from '../mechanics/portalMechanics/PortalInteraction.js';
// Import Three.js for vector and quaternion operations.
import * as THREE from 'three';

// Variable to store the last applied yaw (used for smoothing; currently unused).
let lastAppliedYaw = null;

/**
 * Establishes a connection to the physics SharedWorker. This function sets up the worker port,
 * handles incoming messages, and sends a join message with client token and optional saved state.
 * It also sets up a beforeunload event to save the player's state and notify the worker of departure.
 * @param {void} - No parameters.
 * @returns {void}
 */
export function connectToWorker() {
    // Define the URL of the SharedWorker script.
    const workerUrl = 'src/worker/physicsSharedWorker.js';
    // Create a new SharedWorker instance with module type (ES modules).
    GameState.worker = new SharedWorker(workerUrl, { type: 'module' });
    // Start the message port (required for communication).
    GameState.worker.port.start();

    // ----- Save state and notify worker on page unload -----
    window.addEventListener('beforeunload', () => {
        // If the local player state and player ID exist, save the state to sessionStorage.
        if (GameState.localPlayerState && GameState.playerId && GameState.firstPersonChar) {
            // Build a state object with all necessary fields.
            const stateToSave = {
                playerId: GameState.playerId,
                position: GameState.localPlayerState.position,
                rotation: GameState.rawYaw,
                pitch: GameState.pitch,
                isEquipped: GameState.firstPersonChar.isEquipped,
                inHoldPose: GameState.firstPersonChar.isHoldingPose,
                scale: GameState.localPlayerState.scale,
                velocity: GameState.localPlayerState.velocity,
                onGround: GameState.localPlayerState.onGround,
                teleportSeq: GameState.teleportSeq || 0,
            };
            // Store the serialised state in sessionStorage.
            sessionStorage.setItem('parallaxPlayerState', JSON.stringify(stateToSave));
        }
        // If the worker and player ID exist, send a 'leave' message to the worker.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({ type: 'leave' });
        }
    });

    // ----- Attempt to load saved state from sessionStorage -----
    let savedState = null;
    const savedStateStr = sessionStorage.getItem('parallaxPlayerState');
    if (savedStateStr) {
        try {
            savedState = JSON.parse(savedStateStr);
            // Restore yaw and pitch from saved state (if present) to avoid orientation reset.
            if (savedState.rotation !== undefined) GameState.rawYaw = savedState.rotation;
            if (savedState.pitch !== undefined)    GameState.pitch = savedState.pitch;
            if (savedState.teleportSeq !== undefined) GameState.teleportSeq = savedState.teleportSeq;
        } catch (e) {
            // If parsing fails, ignore and proceed without saved state.
        }
    }

    // ----- Incoming message handler -----
    GameState.worker.port.onmessage = (event) => {
        const msg = event.data;

        // ---- player_id: assigned by the worker ----
        if (msg.type === 'player_id') {
            // Store the assigned player ID.
            GameState.playerId = msg.id;
            // If a teleport sequence number is provided, store it.
            if (msg.teleportSeq !== undefined) GameState.teleportSeq = msg.teleportSeq;
            // Extract the numeric part of the ID for display (e.g., 'p_5' -> 5).
            const num = parseInt(msg.id.split('_')[1]) || 1;
            GameState.myAssignedNumber = num;
            // Update the UI element with the player name.
            document.getElementById('player-id').textContent = `Poopy_${num}`;
            // Store the player ID in sessionStorage for reconnection.
            sessionStorage.setItem('parallaxPlayerId', msg.id);
        }

        // ---- world_state: full state update from the worker ----
        else if (msg.type === 'world_state') {
            // ----- Update block meshes -----
            updateBlocks(msg.blocks);

            // ----- Ensure PortalManager is initialised -----
            if (!PortalManager.initialized && GameState.scene && GameState.renderer) {
                PortalManager.init(GameState.scene, GameState.renderer);
            }
            // Update portal meshes if portals are present in the message.
            if (msg.portals) {
                PortalManager.updatePortals(msg.portals);
            }

            // ----- Handle cooldown frames after teleport -----
            // If skipWorldStateFrames > 0, we are in a cooldown period after a teleport
            // and should skip updating the local player's state (to prevent position snaps).
            if (GameState.skipWorldStateFrames > 0) {
                GameState.skipWorldStateFrames--;
                // Still update remote players and clean up removed remote players.
                for (const p of msg.players) {
                    if (p.id !== GameState.playerId) {
                        RemotePlayerManager.updateRemoteAvatar(p.id, p);
                    }
                }
                for (const [id, player] of GameState.remotePlayers) {
                    if (!msg.players.some((p) => p.id === id)) {
                        RemotePlayerManager.removeAvatar(id);
                    }
                }
                return; // Skip local player updates this frame.
            }

            // ----- Normal handling: update local player from world_state -----
            // Find the local player's state in the message.
            const localPlayer = msg.players.find((p) => p.id === GameState.playerId);
            if (localPlayer) {
                // Store whether the player was being held before this update.
                const wasBeingHeld = GameState.isBeingHeld;
                // Update the local player state.
                GameState.localPlayerState = localPlayer;
                // Update the held flag.
                GameState.isBeingHeld = localPlayer.held || false;

                // If the state includes a scale, update the local model and capsule scale.
                if (localPlayer.scale !== undefined && GameState.firstPersonChar) {
                    GameState.firstPersonChar.setModelScale(localPlayer.scale);
                    if (GameState.physicsPlayer?.capsule) {
                        const capsuleScale = Math.max(localPlayer.scale, 0.01);
                        GameState.physicsPlayer.capsule.scale.set(capsuleScale, capsuleScale, capsuleScale);
                    }
                } else if (!GameState.isBeingHeld && GameState.firstPersonChar) {
                    // If not held and no scale provided, reset to scale 1.
                    GameState.firstPersonChar.setModelScale(1);
                    if (GameState.physicsPlayer?.capsule) {
                        GameState.physicsPlayer.capsule.scale.set(1, 1, 1);
                    }
                }

                // If the player is being held and the state includes a held rotation, apply it.
                if (GameState.isBeingHeld && localPlayer.heldRot && localPlayer.heldRot.length === 4 && GameState.firstPersonChar) {
                    const quat = new THREE.Quaternion().fromArray(localPlayer.heldRot);
                    GameState.firstPersonChar.setModelRotation(quat);
                    if (GameState.physicsPlayer?.capsule) {
                        GameState.physicsPlayer.capsule.quaternion.copy(quat);
                    }
                }

                // If the player was being held and is now released, reset rotation.
                if (wasBeingHeld && !GameState.isBeingHeld) {
                    if (GameState.firstPersonChar?.model) {
                        const quat = new THREE.Quaternion().setFromEuler(
                            new THREE.Euler(0, localPlayer.rotation, 0, 'YXZ')
                        );
                        GameState.firstPersonChar.setModelRotation(quat);
                    }
                    if (GameState.physicsPlayer?.capsule) {
                        GameState.physicsPlayer.capsule.quaternion.identity();
                    }
                }

                // Update equip state (portal gun) from the worker.
                if (GameState.firstPersonChar) {
                    const wasEquipped = GameState.firstPersonChar.isEquipped;
                    const isEquippedNow = localPlayer.isEquipped;
                    const inHoldPoseNow = localPlayer.inHoldPose;
                    GameState.firstPersonChar.isEquipped = isEquippedNow;
                    if (isEquippedNow && !wasEquipped) {
                        // If equipped and not previously, either apply hold pose or sync equip.
                        if (inHoldPoseNow) GameState.firstPersonChar.applyHoldPose();
                        else GameState.firstPersonChar.syncEquip();
                    } else if (!isEquippedNow && wasEquipped) {
                        // If unequipped and was previously, clear hold pose.
                        if (GameState.firstPersonChar.isHoldingPose) {
                            GameState.firstPersonChar.isHoldingPose = false;
                            GameState.firstPersonChar.holdPose = null;
                        }
                    }
                }
            }

            // ----- Update remote players -----
            for (const p of msg.players) {
                if (p.id !== GameState.playerId) {
                    RemotePlayerManager.updateRemoteAvatar(p.id, p);
                }
            }
            // Remove remote players that are no longer in the state.
            for (const [id, player] of GameState.remotePlayers) {
                if (!msg.players.some((p) => p.id === id)) {
                    RemotePlayerManager.removeAvatar(id);
                }
            }
        }

        // ---- portal_camera: forced camera orientation update from worker ----
        else if (msg.type === 'portal_camera') {
            // Override the local yaw and pitch with the worker's values.
            GameState.rawYaw = msg.yaw;
            GameState.pitch = msg.pitch;
            // Apply the new orientation to the camera.
            if (GameState.firstPersonChar && GameState.camera) {
                GameState.camera.quaternion.setFromEuler(
                    new THREE.Euler(GameState.pitch, GameState.rawYaw, 0, 'YXZ')
                );
            }
        }

        // ---- portal_teleport_sync: forced transform after portal traversal ----
        else if (msg.type === 'portal_teleport_sync') {
            // Apply forced sync and start frame‑based cooldown.
            if (GameState.firstPersonChar && GameState.firstPersonChar.model) {
                // Store the forced transform for later use (though applied immediately).
                GameState.syncedModelPosition = new THREE.Vector3().fromArray(msg.position);
                GameState.syncedModelQuaternion = new THREE.Quaternion().fromArray(msg.rotation);
                GameState.syncedModelScale = msg.scale;

                // Immediately update localPlayerState to the new values.
                if (!GameState.localPlayerState) GameState.localPlayerState = {};
                GameState.localPlayerState.position = msg.position;
                GameState.localPlayerState.rotation = msg.yaw;
                GameState.localPlayerState.pitch = msg.pitch;
                GameState.localPlayerState.scale = msg.scale;

                // Store the teleport sequence number to reject stale inputs.
                GameState.teleportSeq = msg.teleportSeq;

                // Update camera orientation.
                GameState.rawYaw = msg.yaw;
                GameState.pitch = msg.pitch;
                if (GameState.camera) {
                    GameState.camera.quaternion.setFromEuler(
                        new THREE.Euler(msg.pitch, msg.yaw, 0, 'YXZ')
                    );
                }

                // Update the physics capsule position and rotation.
                if (GameState.physicsPlayer?.capsule) {
                    GameState.physicsPlayer.capsule.position.copy(GameState.syncedModelPosition);
                    GameState.physicsPlayer.capsule.quaternion.copy(GameState.syncedModelQuaternion);
                    const capsuleScale = Math.max(msg.scale, 0.01);
                    GameState.physicsPlayer.capsule.scale.set(capsuleScale, capsuleScale, capsuleScale);
                }
            }
        }
    };

    // ----- Send join message to the worker -----
    // Retrieve or generate a client token for persistent identification.
    let clientToken = sessionStorage.getItem('parallaxClientToken');
    if (!clientToken) {
        clientToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        sessionStorage.setItem('parallaxClientToken', clientToken);
    }
    // Retrieve any stored player ID for reconnection.
    const storedPlayerId = sessionStorage.getItem('parallaxPlayerId');
    // Build the join message.
    const joinMessage = { type: 'join', playerId: storedPlayerId, clientToken };
    // If saved state exists, include it in the join message.
    if (savedState) joinMessage.initialState = savedState;
    // Send the join message to the worker.
    GameState.worker.port.postMessage(joinMessage);
}