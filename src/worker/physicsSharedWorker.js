/*
Author: Daniel Yu
Date: March 15, 2026
Description: Entry point for the SharedWorker that runs the authoritative physics simulation.
             This file sets up the Cannon.js world, defines global state (players, blocks, ports),
             imports all worker modules, handles client connections (join/leave), and dispatches
             incoming messages to the appropriate handlers (input, pickup, portal placement, proxy, etc.).
             It also initialises the physics world, builds static geometry, creates initial blocks,
             and starts the physics loop. The worker broadcasts full world state to all clients after
             each physics step.
*/

// Import Cannon.js from a CDN (ES module version).
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
// Import worker configuration (constants and timestep).
import { CONFIG } from './worker_config.js';

// ---------- Global state ----------
/** The Cannon.js physics world. */
export const world = new CANNON.World();
// Set gravity (Y axis downward).
world.gravity.set(0, CONFIG.GRAVITY, 0);
// Use SAP broadphase for efficient collision detection.
world.broadphase = new CANNON.SAPBroadphase(world);
// Increase solver iterations for more stable physics.
world.solver.iterations = 100;
// Default restitution for all contacts.
world.defaultContactMaterial.restitution = 0.2;

// Materials for blocks and players.
export const blockMaterial = new CANNON.Material('blockMaterial');
export const playerMaterial = new CANNON.Material('playerMaterial');

// Contact material between blocks and players: low friction, no restitution, stiff springs.
const blockPlayerContact = new CANNON.ContactMaterial(
    blockMaterial, playerMaterial,
    { friction: 0, restitution: 0, contactEquationStiffness: 5e6, contactEquationRelaxation: 4 }
);
world.addContactMaterial(blockPlayerContact);

// Default contact between blocks: moderate friction, slight restitution.
const blockContact = new CANNON.ContactMaterial(
    blockMaterial, blockMaterial,
    { friction: 0.5, restitution: 0.2 }
);
world.addContactMaterial(blockContact);
world.defaultContactMaterial = blockContact;

// Maps for blocks, players, ports, and token lookup.
export let blocks = new Map();          // blockId -> Block instance
export let players = new Map();          // playerId -> Player instance
export let nextPlayerId = 1;             // Counter for generating unique player IDs.
export let ports = new Map();            // MessagePort -> playerId
export let tokenToPlayerId = new Map();  // clientToken -> playerId

// Import portal-related functions and data.
import { playerPortals, placePortal, clearPlayerPortals, getAllPortals } from './worker_portal.js';
// Re-export playerPortals so other modules can access it.
export { playerPortals };

// Import the proxy manager for portal teleportation.
import { ProxyManager } from './worker_portalProxy.js';

/**
 * Generates a new unique player ID in the format 'p_<number>'.
 * @returns {string} The new player ID.
 */
export function generatePlayerId() {
    return 'p_' + (nextPlayerId++);
}

// ---------- Import other worker modules ----------
import { buildWorld } from './worker_world.js';
import { createInitialWorld } from './worker_block.js';
import { startPhysicsLoop } from './worker_physicsLoop.js';
import { Player } from './worker_player.js';
import {
    handleInput,
    handlePickup,
    handleDrop,
    handlePickupRod,
    handleDropRod,
    updateHeldRod,
    handlePickupPlayerRod,
    handleDropPlayerRod,
    updateHeldPlayerRod
} from './worker_handlers.js';

// ---------- Broadcast function ----------
/**
 * Broadcasts the full state (blocks, players, portals) to all connected clients.
 * This is called after each physics step.
 * @returns {void}
 */
function broadcastFullState() {
    // Serialise blocks, players, and portals.
    const blocksState = Array.from(blocks.values(), b => b.getState());
    const playersState = Array.from(players.values(), p => p.getState());
    const portalsState = getAllPortals();
    const message = { type: 'world_state', blocks: blocksState, players: playersState, portals: portalsState };
    // Send to every connected port.
    for (const [port, playerId] of ports) {
        try {
            port.postMessage(message);
        } catch (e) {
            console.warn('Failed to send to port', e);
        }
    }
}

// ---------- Helper to remove a player ----------
/**
 * Removes a player from the world, releasing any held objects (blocks or players),
 * clearing their portals, and notifying all clients.
 * @param {string} playerId - The ID of the player to remove.
 * @returns {void}
 */
function removePlayer(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    // Release any block held by forced perspective (E).
    if (player.heldObjectId) {
        const block = blocks.get(player.heldObjectId);
        if (block) {
            block.owner = null;
            block.body.mass = CONFIG.BLOCK_BASE_MASS * Math.pow(block.scale, 3);
            block.body.type = CANNON.Body.DYNAMIC;
            block.body.updateMassProperties();
        }
    }

    // Release any player held with forced perspective (E) by this player.
    for (const [otherId, otherPlayer] of players) {
        if (otherPlayer.held && otherPlayer.heldBy === playerId) {
            otherPlayer.setHeld(false);
            otherPlayer.body.collisionResponse = true;
            otherPlayer.body.velocity.set(0, 0, 0);
            otherPlayer.body.angularVelocity.set(0, 0, 0);
        }
    }

    // Release any player held with the rod (Q) by this player.
    for (const [otherId, otherPlayer] of players) {
        if (otherPlayer.rodHeld && otherPlayer.rodHeldBy === playerId) {
            handleDropPlayerRod(
                playerId,
                otherId,
                otherPlayer.body.position.toArray(),
                otherPlayer.body.quaternion.toArray(),
                otherPlayer.scale,
                otherPlayer.yaw
            );
        }
    }

    // If this player themselves are held (by someone else), release them.
    if (player.held) {
        player.setHeld(false);
        player.body.collisionResponse = true;
        player.body.velocity.set(0, 0, 0);
        player.body.angularVelocity.set(0, 0, 0);
    }
    if (player.rodHeld) {
        player.rodHeld = false;
        player.rodHeldBy = null;
        player.body.collisionResponse = true;
        player.body.fixedRotation = false;
        player.body.velocity.set(0, 0, 0);
        player.body.angularVelocity.set(0, 0, 0);
    }

    // Remove from maps.
    players.delete(playerId);
    if (player.clientToken) tokenToPlayerId.delete(player.clientToken);
    // Clear the player's portals.
    clearPlayerPortals(playerId);
    // Remove any proxies associated with this player.
    ProxyManager.removeAllProxiesForEntity('player_' + playerId);
    // Broadcast the updated state.
    broadcastFullState();
}

// ---------- Initialise world ----------
// Build static physics bodies (walls, floor, platforms, etc.).
buildWorld();
// Create the initial set of interactive blocks.
createInitialWorld();
// Start the fixed‑step physics loop.
startPhysicsLoop();

// ---------- Connection handling ----------
// The onconnect event is triggered when a new client connects to the SharedWorker.
self.onconnect = (event) => {
    // Get the MessagePort for this connection.
    const port = event.ports[0];

    // Set up the message handler for this port.
    port.onmessage = (msg) => {
        const data = msg.data;

        // ---- join: a client is connecting ----
        if (data.type === 'join') {
            const clientToken = data.clientToken;
            let playerId = data.playerId;
            // Check if this token is already known (reconnect).
            let existingPlayerId = tokenToPlayerId.get(clientToken);

            if (existingPlayerId && players.has(existingPlayerId)) {
                // Reconnecting client: reuse the existing player.
                playerId = existingPlayerId;
                ports.set(port, playerId);
                const player = players.get(playerId);
                player.port = port; // Update port reference.
                port.postMessage({ type: 'player_id', id: playerId });
                broadcastFullState();
                return;
            }
            // If the client supplies a playerId that exists but has no token, it might be a stale reconnect.
            if (playerId && players.has(playerId) && !players.get(playerId).clientToken) {
                const player = players.get(playerId);
                player.clientToken = clientToken;
                tokenToPlayerId.set(clientToken, playerId);
                ports.set(port, playerId);
                player.port = port;
                port.postMessage({ type: 'player_id', id: playerId });
                broadcastFullState();
                return;
            }
            // If a saved state is provided and the playerId is valid, try to restore.
            if (playerId && !players.has(playerId) && data.initialState) {
                const init = data.initialState;
                if (init.playerId === playerId && playerId.startsWith('p_') && /^p_\d+$/.test(playerId)) {
                    const numericPart = parseInt(playerId.substring(2));
                    if (!isNaN(numericPart) && numericPart >= nextPlayerId) nextPlayerId = numericPart + 1;
                    const player = new Player(playerId, { x: init.position[0], y: init.position[1], z: init.position[2] });
                    player.yaw = init.rotation;
                    player.pitch = init.pitch;
                    player.isEquipped = init.isEquipped;
                    player.inHoldPose = init.inHoldPose;
                    if (init.scale !== undefined) player.setScale(init.scale);
                    if (init.velocity) player.velocity = init.velocity;
                    if (init.onGround !== undefined) player.onGround = init.onGround;
                    player.clientToken = clientToken;
                    players.set(playerId, player);
                    tokenToPlayerId.set(clientToken, playerId);
                    ports.set(port, playerId);
                    player.port = port;
                    port.postMessage({ type: 'player_id', id: playerId });
                    broadcastFullState();
                    return;
                }
            }
            // Otherwise, create a new player.
            playerId = generatePlayerId();
            const spawnPos = { x: 0, y: 2, z: 0 };
            const player = new Player(playerId, spawnPos);
            player.clientToken = clientToken;
            players.set(playerId, player);
            tokenToPlayerId.set(clientToken, playerId);
            ports.set(port, playerId);
            player.port = port;
            port.postMessage({ type: 'player_id', id: playerId });
            broadcastFullState();
        }

        // ---- leave: client disconnecting ----
        else if (data.type === 'leave') {
            const playerId = ports.get(port);
            if (playerId) {
                removePlayer(playerId);
                ports.delete(port);
            }
        }

        // ---- input: player movement and actions ----
        else if (data.type === 'input') {
            const playerId = ports.get(port);
            if (playerId) handleInput(playerId, data.input);
        }

        // ---- equip: toggle portal gun equip state ----
        else if (data.type === 'equip') {
            const playerId = ports.get(port);
            if (playerId) {
                const player = players.get(playerId);
                if (player) {
                    player.isEquipped = data.equipped;
                    broadcastFullState();
                }
            }
        }

        // ---- set_hold_pose: update hold pose state ----
        else if (data.type === 'set_hold_pose') {
            const playerId = ports.get(port);
            if (playerId) {
                const player = players.get(playerId);
                if (player) {
                    player.inHoldPose = data.inHoldPose;
                    broadcastFullState();
                }
            }
        }

        // ---- pickup: forced perspective grab (E) ----
        else if (data.type === 'pickup') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                handlePickup(playerId, data.objectId, data.rotation);
                broadcastFullState();
            }
        }

        // ---- drop: forced perspective drop ----
        else if (data.type === 'drop') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                handleDrop(playerId, data.position, data.scale, data.rotation);
                broadcastFullState();
            }
        }

        // ---- update_held: update forced‑perspective held block ----
        else if (data.type === 'update_held') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                const player = players.get(playerId);
                const block = blocks.get(data.objectId);
                if (player && block && block.owner === playerId) {
                    block.heldPos = data.position;
                    block.heldRot = data.rotation;
                    block.heldScale = data.scale;
                    player.heldPos = data.position;
                    player.heldRot = data.rotation;
                    player.heldScale = data.scale;
                    block.body.position.set(data.position[0], data.position[1], data.position[2]);
                    block.body.quaternion.set(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]);
                }
            }
        }

        // ---- pickup_player: forced perspective grab on a player ----
        else if (data.type === 'pickup_player') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                const targetPlayer = players.get(data.playerId);
                if (targetPlayer && !targetPlayer.held) {
                    targetPlayer.setHeld(true, data.position, data.rotation, data.cameraYaw, data.cameraPitch, playerId);
                    if (data.scale !== undefined) targetPlayer.setScale(data.scale);

                    // Clear existing contacts to avoid collisions while held.
                    world.contacts = world.contacts.filter(
                        c => c.bi !== targetPlayer.body && c.bj !== targetPlayer.body
                    );
                    targetPlayer.body.velocity.set(0, 0, 0);
                    targetPlayer.body.angularVelocity.set(0, 0, 0);

                    broadcastFullState();
                }
            }
        }

        // ---- drop_player: forced perspective drop of a player ----
        else if (data.type === 'drop_player') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                const targetPlayer = players.get(data.playerId);
                if (targetPlayer && targetPlayer.held) {
                    targetPlayer.setHeld(false);
                    targetPlayer.body.collisionResponse = true;
                    targetPlayer.body.position.set(data.position[0], data.position[1], data.position[2]);
                    targetPlayer.body.quaternion.set(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]);
                    targetPlayer.body.velocity.set(0, 0, 0);
                    targetPlayer.body.angularVelocity.set(0, 0, 0);
                    if (data.finalYaw !== undefined) targetPlayer.yaw = data.finalYaw;
                    if (data.scale !== undefined) targetPlayer.setScale(data.scale);
                    broadcastFullState();
                }
            }
        }

        // ---- update_held_player: update forced‑perspective held player ----
        else if (data.type === 'update_held_player') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                const targetPlayer = players.get(data.playerId);
                if (targetPlayer && targetPlayer.held) {
                    targetPlayer.heldPos = data.position;
                    targetPlayer.heldRot = data.rotation;
                    if (data.scale !== undefined) {
                        targetPlayer.heldScale = data.scale;
                        targetPlayer.setScale(data.scale);
                    }
                    targetPlayer.body.type = CANNON.Body.KINEMATIC;
                    targetPlayer.body.collisionResponse = false;
                    targetPlayer.body.updateMassProperties();

                    targetPlayer.body.position.set(data.position[0], data.position[1], data.position[2]);
                    targetPlayer.body.quaternion.set(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]);
                }
            }
        }

        // ========== Portal Messages ==========
        // ---- place_portal: place a portal of a given type ----
        else if (data.type === 'place_portal') {
            const playerId = ports.get(port);
            if (playerId && data.portalType) {
                const pos = new CANNON.Vec3(data.position[0], data.position[1], data.position[2]);
                const rot = new CANNON.Quaternion(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]);
                placePortal(playerId, data.portalType, pos, rot);
                broadcastFullState();
            }
        }

        // ---- clear_portals: remove all portals belonging to the player ----
        else if (data.type === 'clear_portals') {
            const playerId = ports.get(port);
            if (playerId) {
                clearPlayerPortals(playerId);
                broadcastFullState();
            }
        }

        // ========== Rod Handlers (Q) ==========
        // ---- pickup_rod: pick up a block with the rod ----
        else if (data.type === 'pickup_rod') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                handlePickupRod(playerId, data.objectId, data.initialTarget);
                broadcastFullState();
            }
        }

        // ---- drop_rod: drop a block from the rod ----
        else if (data.type === 'drop_rod') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                handleDropRod(playerId, data.objectId, data.position, data.scale, data.rotation);
                broadcastFullState();
            }
        }

        // ---- update_held_rod: update rod‑held block position ----
        else if (data.type === 'update_held_rod') {
            const playerId = ports.get(port);
            if (playerId && data.objectId) {
                updateHeldRod(playerId, data.objectId, data.position, data.rotation, data.scale);
            }
        }

        // ---- pickup_player_rod: pick up a player with the rod ----
        else if (data.type === 'pickup_player_rod') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                handlePickupPlayerRod(playerId, data.playerId, data.initialTarget);
                broadcastFullState();
            }
        }

        // ---- drop_player_rod: drop a player from the rod ----
        else if (data.type === 'drop_player_rod') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                handleDropPlayerRod(playerId, data.playerId, data.position, data.rotation, data.scale, data.finalYaw);
                broadcastFullState();
            }
        }

        // ---- update_held_player_rod: update rod‑held player position ----
        else if (data.type === 'update_held_player_rod') {
            const playerId = ports.get(port);
            if (playerId && data.playerId) {
                updateHeldPlayerRod(playerId, data.playerId, data.position);
            }
        }

        // ========== Proxy and Teleport Messages ==========
        // ---- start_proxy: notify worker that a client has started a proxy for an entity ----
        else if (data.type === 'start_proxy') {
            const playerId = ports.get(port);
            if (playerId) {
                ProxyManager.startProxy(
                    data.entityId,
                    data.entrancePortalId,
                    data.exitPortalId,
                    data.entrancePosition,
                    data.entranceRotation,
                    data.exitPosition,
                    data.exitRotation
                );
            }
        }

        // ---- stop_proxy: notify worker that a client has stopped a proxy ----
        else if (data.type === 'stop_proxy') {
            const playerId = ports.get(port);
            if (playerId) {
                ProxyManager.stopProxy(data.entityId);
            }
        }
    };

    // When the port is closed, clean up the player.
    port.onclose = () => {
        const playerId = ports.get(port);
        if (playerId) {
            removePlayer(playerId);
            ports.delete(port);
        }
    };
};