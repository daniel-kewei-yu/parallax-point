/*
Author: Daniel Yu
Date: June 18, 2026
Description: Manages portal interactions for the local player and other entities in the scene.
             This module handles two main responsibilities:
             1. Proxy creation and management: when an object (player, block, remote player) intersects
                a portal, a visual clone (proxy) is created on the exit side, with clipping planes applied
                to both the original and the clone for seamless teleportation.
             2. Camera detachment: when the local player's eye crosses a portal while the body still
                straddles the portal plane, the camera detaches and renders from the exit portal's
                perspective. This provides a smooth portal traversal experience.
             The system uses sign-change detection with hysteresis to avoid rapid toggling.
*/

import * as THREE from 'three';
import { GameState } from '../../clientState.js';
import { PortalManager } from './PortalManager.js';
import { PortalProxyManager } from './PortalProxyManager.js';
import { CLIENT_CONFIG } from '../../clientConfig.js';

// Constants for portal dimensions and activation distances.
const PORTAL_RADIUS = 1.25;          // Radius of the portal disc (before scaling).
const ACTIVATION_DIST = 1.2;          // How far beyond the portal plane an object can be before proxy is deactivated.

/**
 * Singleton object that coordinates all portal interactions.
 * It tracks entities (players, blocks) that are near portals, creates/destroys proxies,
 * and manages the camera detachment state for the local player.
 */
export const PortalInteraction = {
    // Set of entity IDs that are currently being tracked for portal interaction.
    trackedEntities: new Set(),
    // Map from entity ID to additional data (currently unused, but reserved for future use).
    trackingData: new Map(),
    // Flag indicating whether the module has been initialised.
    initialized: false,
    // Reusable vector to avoid allocations during calculations.
    _helperVec: new THREE.Vector3(),
    // Map from portal ID to the last signed distance of the local player's eye from that portal's plane.
    // Used for sign-change detection.
    _lastEyeSignedDist: new Map(),
    // Stores the sign (positive or negative) of the eye position relative to the portal plane when detachment occurred.
    // This is used to determine when to reattach the camera.
    _detachedEyeSign: null,

    /**
     * Initialises the portal interaction system.
     * Must be called once after PortalManager and PortalProxyManager are initialised.
     * @param {void} - No parameters.
     * @returns {void}
     */
    init() {
        this.initialized = true;
    },

    /**
     * Main update function called every frame by the render loop.
     * It updates proxies for all entities near portals and handles camera detachment.
     * @param {void} - No parameters.
     * @returns {void}
     */
    update() {
        // If not initialised, skip all updates.
        if (!this.initialized) return;

        // If there are no portals in the scene, there is nothing to interact with.
        if (PortalManager.allPortals.size === 0) return;

        // Update all active proxies (clones) to match the latest transforms and clipping states.
        PortalProxyManager.updateAll();

        // ----- Local player proxy management -----
        // Check if the local player's model intersects any portal and manage proxies for it.
        if (GameState.firstPersonChar?.model && GameState.localPlayerState) {
            // Use a unique entity ID for the local player (prefixed with 'player_' and the player ID).
            this.checkEntityAgainstPortals(
                'player_' + GameState.playerId,
                GameState.firstPersonChar.model
            );
        }

        // ----- Block proxy management -----
        // Iterate over all blocks in the world and check each one against portals.
        for (const [blockId, mesh] of GameState.worldObjects) {
            this.checkEntityAgainstPortals('block_' + blockId, mesh);
        }

        // ----- Remote player proxy management -----
        // Iterate over all remote players and check their avatar or capsule against portals.
        for (const [playerId, playerData] of GameState.remotePlayers) {
            // Use the avatar if available, otherwise the capsule mesh.
            const mesh = playerData.avatar || playerData.capsule;
            if (mesh) {
                this.checkEntityAgainstPortals('player_' + playerId, mesh);
            }
        }

        // ----- Camera detachment logic (split-phase portal traversal) -----
        // Update the camera detachment state based on the local player's eye and capsule positions.
        this.updateCameraCrossing();
    },

    // --------------------------------------------------------------
    // PROXY CREATION – determines when to start/stop visual proxies
    // --------------------------------------------------------------

    /**
     * Checks whether a given entity (identified by entityId) intersects any portal.
     * If it does, and it is within the activation zone, a proxy is started on the exit side.
     * If it no longer intersects, any active proxy for that entity is stopped.
     * @param {string} entityId - Unique identifier (e.g., 'player_p_5', 'block_abc123').
     * @param {THREE.Object3D} mesh - The mesh representing the entity (used for bounding box).
     * @returns {void}
     */
    checkEntityAgainstPortals(entityId, mesh) {
        // If the mesh is invalid, do nothing.
        if (!mesh) return;

        // Compute the world-space axis-aligned bounding box of the entity.
        const box = new THREE.Box3().setFromObject(mesh);
        // Get the centre of the bounding box (approximate position of the entity).
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Iterate over all portal pairs in the scene.
        for (const [, pair] of PortalManager.portalPairs) {
            // For each pair, check both the blue and orange portals.
            for (const portal of [pair.blue, pair.orange]) {
                // Skip if the portal is null.
                if (!portal) continue;

                // Find the paired portal (the exit portal for this entrance).
                const exitPortal = PortalManager.getPair(portal);
                if (!exitPortal) continue; // Skip if no pair exists.

                // Quick broad-phase: if the entity's bounding box does not intersect the portal's plane,
                // we can stop any proxy associated with this portal and continue to the next portal.
                if (!portal.plane.intersectsBox(box)) {
                    this._stopProxyIfActive(entityId, portal);
                    continue;
                }

                // Compute the signed distance from the entity centre to the portal plane.
                const signedDist = portal.signedDistance(center);

                // Check if the entity centre is inside the portal's elliptical disc.
                const insideEllipse = this._isPointInsidePortalEllipse(center, portal);

                // Check if the entity is within the activation zone: within ACTIVATION_DIST in front,
                // and no more than 2 * player radius behind (to avoid proxying objects that are too far behind).
                const inActivationZone = (signedDist < ACTIVATION_DIST &&
                                          signedDist > -CLIENT_CONFIG.PLAYER_RADIUS * 2);

                // If not inside the ellipse or not in the activation zone, stop any proxy and continue.
                if (!insideEllipse || !inActivationZone) {
                    this._stopProxyIfActive(entityId, portal);
                    continue;
                }

                // If we reach here, the entity is inside the ellipse and within the activation zone.
                // If a proxy is not already active, start one.
                if (!PortalProxyManager.isProxying(entityId)) {
                    // Compute the size of the bounding box to estimate how far the entity has crossed.
                    const size = new THREE.Vector3();
                    box.getSize(size);
                    const halfExtent = size.length() * 0.5; // Approximate radius of the entity.

                    // Compute the fraction of the entity that has crossed the portal plane.
                    // This ranges from 0 (just touching) to 1 (fully crossed).
                    const crossedFraction = Math.max(0, Math.min(1,
                        (halfExtent - signedDist) / (2 * halfExtent)
                    ));

                    // Start the proxy: clone the mesh and apply clipping to both original and clone.
                    PortalProxyManager.startProxy(
                        entityId,
                        mesh,
                        portal,
                        exitPortal,
                        crossedFraction
                    );

                    // Notify the worker that a proxy has started for this entity.
                    this.sendStartProxy(entityId, portal, exitPortal);
                }

                // Once we've handled this portal, we can return (an entity can only have one active proxy at a time).
                return;
            }
        }
    },

    /**
     * Tests whether a world-space point lies inside the elliptical disc of a portal.
     * The portal's disc is scaled by (0.8, 1.2) relative to the base radius.
     * @param {THREE.Vector3} worldPoint - World-space point to test.
     * @param {Portal} portal - The portal whose disc is being tested.
     * @returns {boolean} True if the point is inside the ellipse, false otherwise.
     */
    _isPointInsidePortalEllipse(worldPoint, portal) {
        // Transform the point from world space into the portal's local coordinate system.
        // The local origin is the portal centre, and the local axes are aligned with the portal's rotation.
        // In local space, the portal disc lies in the XY plane, with Z = 0.
        const localPoint = worldPoint.clone().sub(portal.position)
            .applyQuaternion(portal.rotation.clone().invert());

        // Get the scale factors applied to the portal disc (set in Portal.createMeshes).
        const scaleX = portal.discMesh.scale.x; // Typically 0.8
        const scaleY = portal.discMesh.scale.y; // Typically 1.2

        // Compute the actual radii of the ellipse.
        const rx = PORTAL_RADIUS * scaleX;
        const ry = PORTAL_RADIUS * scaleY;

        // Normalise the local point by the radii.
        const xn = localPoint.x / rx;
        const yn = localPoint.y / ry;

        // Check if the point lies within the unit circle (ellipse test).
        return (xn * xn + yn * yn) <= 1.0;
    },

    /**
     * Stops the proxy for the given entity if it is currently active and associated with the specified portal.
     * @param {string} entityId - The entity ID.
     * @param {Portal} portal - The portal to check against.
     * @returns {void}
     */
    _stopProxyIfActive(entityId, portal) {
        // If no proxy is active for this entity, do nothing.
        if (!PortalProxyManager.isProxying(entityId)) return;

        // Get the active proxy data.
        const proxy = PortalProxyManager.getProxy(entityId);
        // If the proxy's entrance portal matches the given portal, stop it.
        if (proxy && proxy.entrancePortal === portal) {
            PortalProxyManager.stopProxy(entityId);
            // Notify the worker that the proxy has been stopped.
            this.sendStopProxy(entityId);
        }
    },

    // --------------------------------------------------------------
    // CAMERA DETACHMENT – sign‑change hysteresis
    // --------------------------------------------------------------

    /**
     * Updates the camera detachment state based on the local player's eye and capsule positions.
     * It uses sign-change detection with hysteresis to detach/reattach the camera smoothly.
     * This is called every frame from the main update loop.
     * @param {void} - No parameters.
     * @returns {void}
     */
    updateCameraCrossing() {
        // If the local player character does not exist, skip.
        if (!GameState.firstPersonChar) return;

        // Get the current world position of the player's eye.
        const eyePos = GameState.firstPersonChar.getEyeWorldPosition();

        // Get the physics capsule mesh (used to compute the capsule extents).
        const capsule = GameState.physicsPlayer?.capsule;
        if (!capsule) return;

        // Get the current scale of the player.
        const scale = GameState.localPlayerState?.scale || 1;

        // Compute the capsule's radius and half-height based on scale.
        const radius = CLIENT_CONFIG.PLAYER_RADIUS * scale;
        const halfHeight = (CLIENT_CONFIG.PLAYER_HEIGHT / 2) * scale;

        // The centre of the capsule is stored in the capsule mesh's position.
        const centerPos = capsule.position.clone();

        // Variables to track whether detachment should occur and which portals are involved.
        let shouldDetach = false;
        let entrancePortal = null;
        let exitPortal = null;

        // Iterate over all portal pairs.
        for (const [, pair] of PortalManager.portalPairs) {
            // Check both directions: entrance -> exit and exit -> entrance.
            for (const [portal, other] of [
                [pair.blue, pair.orange],
                [pair.orange, pair.blue]
            ]) {
                // Skip if either portal is null.
                if (!portal || !other) continue;

                // Step 1: The eye must be inside the portal's elliptical disc.
                if (!this._isPointInsidePortalEllipse(eyePos, portal)) {
                    continue;
                }

                // Step 2: Compute the capsule's extents along the portal normal.
                // The capsule is approximated as a vertical cylinder. We project it onto the portal normal.
                const normal = portal.forward.clone().normalize();

                // Compute the signed distance from the capsule centre to the portal plane.
                const dCenter = normal.dot(centerPos.clone().sub(portal.position));

                // Compute the contribution of the capsule's vertical extent and radial extent to the total projection.
                // The vertical contribution depends on how aligned the capsule's up vector is with the portal normal.
                const up = new THREE.Vector3(0, 1, 0);
                const upDot = up.dot(normal);
                // The vertical extent projected onto the normal: halfHeight * |upDot|.
                const verticalContrib = halfHeight * Math.abs(upDot);
                // The radial extent projected onto the normal: radius * sqrt(1 - upDot^2).
                const radialContrib = radius * Math.sqrt(Math.max(0, 1 - upDot * upDot));

                // The capsule's min and max extent along the portal normal.
                const dMin = dCenter - verticalContrib - radialContrib;
                const dMax = dCenter + verticalContrib + radialContrib;

                // Compute the signed distance of the eye from the portal plane.
                const dEye = normal.dot(eyePos.clone().sub(portal.position));

                // Check if the capsule straddles the portal plane (i.e., the plane intersects the capsule).
                const straddling = dMin < -0.001 && dMax > 0.001;

                // Get the previous signed distance of the eye for this portal.
                const key = portal.id;
                const prevD = this._lastEyeSignedDist.get(key);

                // Detect if the eye has crossed the portal plane (sign change).
                const signChanged = prevD !== undefined && (prevD * dEye < 0);

                // Determine if the eye is currently on the positive side (in front of the portal).
                const currentEyePositive = dEye > 0.001;

                // ----- State machine for detachment -----
                if (GameState.cameraDetached) {
                    // If the camera is already detached:
                    // - If the capsule no longer straddles the portal, reattach.
                    if (!straddling) {
                        shouldDetach = false;
                        this._lastEyeSignedDist.delete(key);
                        this._detachedEyeSign = null;
                        break;
                    }

                    // - If the eye has crossed back to the original side (opposite of the sign when detached), reattach.
                    if (this._detachedEyeSign !== null && currentEyePositive !== this._detachedEyeSign) {
                        shouldDetach = false;
                        this._lastEyeSignedDist.delete(key);
                        this._detachedEyeSign = null;
                        break;
                    }

                    // Otherwise, stay detached.
                    shouldDetach = true;
                    entrancePortal = portal;
                    exitPortal = other;
                    this._lastEyeSignedDist.set(key, dEye);
                    break;
                } else {
                    // If the camera is not detached:
                    // - Enter detached mode only if the eye just crossed AND the capsule straddles the plane.
                    if (signChanged && straddling) {
                        shouldDetach = true;
                        entrancePortal = portal;
                        exitPortal = other;
                        // Store the sign we crossed to (positive or negative) for reattachment logic.
                        this._detachedEyeSign = currentEyePositive;
                        this._lastEyeSignedDist.set(key, dEye);
                        break;
                    }
                    // Update the stored distance for future sign checks.
                    this._lastEyeSignedDist.set(key, dEye);
                }
            }
            // If we have determined a detachment action (or are already detached and need to reattach), break out of the outer loop.
            if (shouldDetach || (GameState.cameraDetached && !shouldDetach)) break;
        }

        // Apply the detachment/reattachment decision.
        if (shouldDetach) {
            // If we are not already detached, enter detached mode.
            if (!GameState.cameraDetached) {
                this._enterDetachedMode(entrancePortal, exitPortal);
            }
        } else {
            // If we are currently detached and should not be, exit detached mode.
            if (GameState.cameraDetached) {
                this._exitDetachedMode();
                // Clear all stored eye distances when reattaching to avoid stale data.
                this._lastEyeSignedDist.clear();
                this._detachedEyeSign = null;
            }
        }
    },

    /**
     * Enters detached camera mode: the camera is positioned and oriented from the exit portal's perspective.
     * The body remains on the entrance side until the capsule fully crosses.
     * @param {Portal} entrancePortal - The portal the eye crossed.
     * @param {Portal} exitPortal - The paired portal to render from.
     * @returns {void}
     */
    _enterDetachedMode(entrancePortal, exitPortal) {
        // Compute a transformation matrix that maps positions from the entrance portal's space to the exit portal's space.
        // This includes a 180-degree rotation around Y to account for the portal's mirroring effect.
        const rotY = new THREE.Matrix4().makeRotationY(Math.PI);
        const entranceMat = new THREE.Matrix4().compose(
            entrancePortal.position,
            entrancePortal.rotation,
            new THREE.Vector3(1, 1, 1)
        );
        const exitMat = new THREE.Matrix4().compose(
            exitPortal.position,
            exitPortal.rotation,
            new THREE.Vector3(1, 1, 1)
        );
        const transform = new THREE.Matrix4()
            .multiplyMatrices(exitMat, rotY)
            .multiply(entranceMat.clone().invert());

        // Set the detached state variables in the global state.
        GameState.cameraDetached = true;
        GameState.detachEntrancePortal = entrancePortal;
        GameState.detachExitPortal = exitPortal;
        GameState.detachTransformMatrix = transform;

        // Notify the worker that the camera has crossed the portal.
        // This is used for synchronisation with other clients.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({
                type: 'camera_crossed',
                entrancePortalId: entrancePortal.id,
                exitPortalId: exitPortal.id
            });
        }
    },

    /**
     * Exits detached camera mode: restores the camera to the local player's body position.
     * This is called when the capsule no longer straddles the portal or the eye crosses back.
     * @param {void} - No parameters.
     * @returns {void}
     */
    _exitDetachedMode() {
        // Reset the detached state flags.
        GameState.cameraDetached = false;
        GameState.detachEntrancePortal = null;
        GameState.detachExitPortal = null;
        GameState.detachTransformMatrix = null;

        // Clear all stored eye distances and sign to avoid stale data on the next crossing.
        this._lastEyeSignedDist.clear();
        this._detachedEyeSign = null;
    },

    // ---------- Worker communication for proxies ----------

    /**
     * Sends a message to the worker to start a proxy for an entity.
     * The worker uses this to track the entity for teleportation (trailing-edge detection).
     * @param {string} entityId - The entity ID (e.g., 'player_p_5').
     * @param {Portal} entrancePortal - The portal the entity is intersecting.
     * @param {Portal} exitPortal - The paired exit portal.
     * @returns {void}
     */
    sendStartProxy(entityId, entrancePortal, exitPortal) {
        if (!GameState.worker) return;

        // Determine if the entity is a block or a player from the prefix.
        const isBlock = entityId.startsWith('block_');
        const id = entityId.replace(/^(block_|player_)/, '');

        GameState.worker.port.postMessage({
            type: 'start_proxy',
            entityId,
            objectId: isBlock ? id : undefined,
            playerId: !isBlock ? id : undefined,
            entrancePortalId: entrancePortal.id,
            exitPortalId: exitPortal.id,
            entrancePosition: entrancePortal.position.toArray(),
            entranceRotation: entrancePortal.rotation.toArray(),
            exitPosition: exitPortal.position.toArray(),
            exitRotation: exitPortal.rotation.toArray(),
        });
    },

    /**
     * Sends a message to the worker to stop a proxy for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {void}
     */
    sendStopProxy(entityId) {
        if (!GameState.worker) return;
        GameState.worker.port.postMessage({
            type: 'stop_proxy',
            entityId,
        });
    },
};