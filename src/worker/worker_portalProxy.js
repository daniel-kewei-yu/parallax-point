/*
Author: Daniel Yu
Date: June 18, 2026
Description: Implements bidirectional portal teleportation for players and blocks on the physics worker.
             This module tracks bodies (players and blocks) that are near portals, detects when they
             cross a portal plane, and performs a "role swap": the body is removed from the world and
             a new body is created at the exit portal with transformed velocity and orientation.
             Trailing‑edge detection ensures that players teleport only when the entire capsule has
             passed the plane, while blocks teleport when their full AABB has crossed. The system also
             handles pending swaps and updates the client's camera orientation on teleport.
*/

import { world, blocks, players, blockMaterial, playerMaterial } from './physicsSharedWorker.js';
import { playerPortals } from './worker_portal.js';
import { CONFIG } from './worker_config.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// Constants for portal detection and activation.
const PORTAL_RADIUS = 1.25;
const ACTIVATION_DIST = CONFIG.PLAYER_HEIGHT * 0.5;
const PLAYER_HEIGHT = CONFIG.PLAYER_HEIGHT;
const PLAYER_RADIUS = CONFIG.PLAYER_RADIUS || 0.5;

/**
 * Singleton object that manages portal proxies and teleportation.
 * It tracks active proxies, pending swaps, and performs role swaps.
 */
export const ProxyManager = {
    // Map from entityId to proxy data { masterBody, entrancePortal, exitPortal }.
    proxies: new Map(),
    // Map from key (entityId + '|' + portalId) to last signed distance (for sign detection).
    _lastSignedDist: new Map(),
    // Map from key to pending swap data { entityId, body, entrancePortal, exitPortal, entryDirection, setTime }.
    _pendingSwaps: new Map(),

    /**
     * Updates portal interactions for all players and blocks.
     * Called every physics step.
     * @param {void} - No parameters.
     * @returns {void}
     */
    updatePortalInteractions() {
        const now = performance.now();
        // Process all players (skip those held by forced perspective).
        for (const player of players.values()) {
            if (player.held) continue;
            this._processBody('player_' + player.id, player.body, now);
        }
        // Process all blocks.
        for (const block of blocks.values()) {
            this._processBody('block_' + block.id, block.body, now);
        }
        // Check if any pending swaps are ready to execute.
        this._checkPendingSwaps(now);
    },

    /**
     * Starts a proxy for an entity. Called by the client when a proxy is created.
     * Stores the master body and portal references.
     * @param {string} entityId - The entity ID (e.g., 'player_p_5').
     * @param {string} entrancePortalId - ID of the entrance portal.
     * @param {string} exitPortalId - ID of the exit portal.
     * @param {Array} entrancePosition - Position of entrance portal [x,y,z] (unused).
     * @param {Array} entranceRotation - Rotation of entrance portal [x,y,z,w] (unused).
     * @param {Array} exitPosition - Position of exit portal [x,y,z] (unused).
     * @param {Array} exitRotation - Rotation of exit portal [x,y,z,w] (unused).
     * @returns {void}
     */
    startProxy(entityId, entrancePortalId, exitPortalId,
        entrancePosition, entranceRotation, exitPosition, exitRotation) {
        const mainBody = this.getMainBody(entityId);
        if (!mainBody) return;
        const entrancePortal = this._getPortalById(entrancePortalId);
        const exitPortal = this._getPortalById(exitPortalId);
        if (!entrancePortal || !exitPortal) return;
        if (!this.proxies.has(entityId)) {
            this.proxies.set(entityId, {
                masterBody: mainBody,
                entrancePortal,
                exitPortal,
            });
        }
    },

    /**
     * Stops a proxy for an entity. Called by the client when a proxy is stopped.
     * Removes the proxy entry and cancels any pending swap for that entity.
     * @param {string} entityId - The entity ID.
     * @returns {void}
     */
    stopProxy(entityId) {
        this.removeAllProxiesForEntity(entityId);
        // Cancel any pending swap for this entity.
        for (const [key, data] of this._pendingSwaps) {
            if (data.entityId === entityId) {
                this._pendingSwaps.delete(key);
            }
        }
    },

    /**
     * Processes a single body (player or block) against all portal pairs.
     * It checks if the body is inside a portal's disc and within the activation zone,
     * and sets up pending swaps when a crossing is detected.
     * @param {string} entityId - The entity ID.
     * @param {CANNON.Body} body - The physics body.
     * @param {number} now - Current timestamp (for pending swap timing).
     * @returns {void}
     */
    _processBody(entityId, body, now) {
        // Iterate over all portal pairs owned by players.
        for (const [ownerId, portals] of playerPortals) {
            if (!portals.blue || !portals.orange) continue;
            // Check both directions: portal -> pair and pair -> portal.
            for (const portal of [portals.blue, portals.orange]) {
                const pair = portal === portals.blue ? portals.orange : portals.blue;
                if (!pair) continue;

                // Compute the body's position relative to the portal.
                const offset = body.position.vsub(portal.position);
                // Transform into portal local space (so Z is along the portal normal).
                const localPos = portal.rotation.inverse().vmult(offset);
                const signedDist = localPos.z;

                // Check if the body's centre is inside the portal's elliptical disc.
                const detectionScale = 1.5; // Slightly larger than the visual disc.
                const rx = PORTAL_RADIUS * 0.8 * detectionScale;
                const ry = PORTAL_RADIUS * 1.2 * detectionScale;
                const insideDisc = (localPos.x * localPos.x) / (rx * rx) +
                    (localPos.y * localPos.y) / (ry * ry) <= 1.0;

                const key = entityId + '|' + portal.id;

                // If not inside the disc, clear any stored distance and cancel pending swaps.
                if (!insideDisc) {
                    if (!this._pendingSwaps.has(key)) {
                        this._lastSignedDist.delete(key);
                        this._cancelPendingSwap(entityId, portal.id);
                    }
                    continue;
                }

                // If there is already a pending swap for this entity, skip further checks.
                if (this._hasPendingSwap(entityId)) continue;

                // If the body is within the activation distance, create or update a proxy.
                const absDist = Math.abs(signedDist);
                if (absDist < ACTIVATION_DIST) {
                    // Ensure a proxy exists.
                    if (!this.proxies.has(entityId)) {
                        this.proxies.set(entityId, {
                            masterBody: body,
                            entrancePortal: portal,
                            exitPortal: pair,
                        });
                    } else {
                        // Update the master body reference in case it changed.
                        this.proxies.get(entityId).masterBody = body;
                    }

                    // Check for crossing: sign change from previous frame.
                    const prev = this._lastSignedDist.get(key);
                    this._lastSignedDist.set(key, signedDist);
                    const crossed = prev !== undefined && (prev > 0 && signedDist < 0 || prev < 0 && signedDist > 0);

                    if (crossed) {
                        // A crossing occurred: set up a pending swap.
                        const entrancePortal = portal;
                        const exitPortal = pair;
                        const entryDirection = prev > 0 ? 'front' : 'back'; // Which side the body came from.
                        this._setPendingSwap(entityId, body, entrancePortal, exitPortal, entryDirection, now);
                        // Clear the stored distance to avoid repeated crossings.
                        this._lastSignedDist.delete(key);
                    }
                } else {
                    // Body is outside the activation zone: clear stored distance.
                    this._lastSignedDist.delete(key);
                }
            }
        }
    },

    /**
     * Checks if there is a pending swap for the given entity.
     * @param {string} entityId - The entity ID.
     * @returns {boolean} True if a pending swap exists.
     */
    _hasPendingSwap(entityId) {
        for (const [key, data] of this._pendingSwaps) {
            if (data.entityId === entityId) return true;
        }
        return false;
    },

    /**
     * Sets a pending swap for an entity that has crossed a portal.
     * The swap will be executed when the trailing edge of the body passes the portal plane.
     * @param {string} entityId - The entity ID.
     * @param {CANNON.Body} body - The physics body.
     * @param {Portal} entrancePortal - The portal being crossed.
     * @param {Portal} exitPortal - The paired exit portal.
     * @param {string} entryDirection - 'front' or 'back' (which side the body came from).
     * @param {number} timestamp - The time the crossing was detected.
     * @returns {void}
     */
    _setPendingSwap(entityId, body, entrancePortal, exitPortal, entryDirection, timestamp) {
        const key = entityId + '|' + entrancePortal.id;
        this._pendingSwaps.set(key, {
            entityId,
            body,
            entrancePortal,
            exitPortal,
            entryDirection,
            setTime: timestamp
        });
    },

    /**
     * Cancels a pending swap for an entity and portal.
     * @param {string} entityId - The entity ID.
     * @param {string} portalId - The portal ID.
     * @returns {void}
     */
    _cancelPendingSwap(entityId, portalId) {
        const key = entityId + '|' + portalId;
        this._pendingSwaps.delete(key);
    },

    /**
     * Checks all pending swaps and executes them when the trailing edge of the body
     * has fully passed the portal plane. This is the core of the teleportation logic.
     * @param {number} now - Current timestamp (unused).
     * @returns {void}
     */
    _checkPendingSwaps(now) {
        for (const [key, data] of this._pendingSwaps) {
            const { entityId, body, entrancePortal, exitPortal, entryDirection } = data;

            // If the body has been removed from the world, cancel the swap.
            if (!world.bodies.includes(body)) {
                this._pendingSwaps.delete(key);
                continue;
            }

            // Compute the signed distance of the body's centre from the entrance portal.
            const offset = body.position.vsub(entrancePortal.position);
            const localPos = entrancePortal.rotation.inverse().vmult(offset);
            const signedDist = localPos.z;

            // If the body has moved back to the original side before crossing fully, cancel.
            if ((entryDirection === 'front' && signedDist >= 0) ||
                (entryDirection === 'back' && signedDist <= 0)) {
                this._pendingSwaps.delete(key);
                continue;
            }

            // Check if the trailing edge has passed the portal plane.
            const trailingPassed = this._checkTrailingEdge(body, entrancePortal, entryDirection, entityId);
            if (trailingPassed) {
                // Execute the role swap (teleport).
                this._performRoleSwap(entityId, entrancePortal, exitPortal, body);
                this._pendingSwaps.delete(key);
            }
        }
    },

    /**
     * Checks if the trailing edge of a body has fully passed the portal plane.
     * For blocks, it uses the full AABB extents projected onto the portal normal.
     * For players, it uses the capsule's extents (halfHeight + radius) projected.
     * @param {CANNON.Body} body - The physics body.
     * @param {Portal} portal - The entrance portal.
     * @param {string} entryDirection - 'front' or 'back'.
     * @param {string} entityId - The entity ID (used to distinguish player vs block).
     * @returns {boolean} True if the trailing edge has passed the plane.
     */
    _checkTrailingEdge(body, portal, entryDirection, entityId) {
        // ---- BLOCK: compute full-body crossing using shape extents ----
        if (entityId.startsWith('block_')) {
            const normal = new CANNON.Vec3(0, 0, 1);
            portal.rotation.vmult(normal, normal);
            const pos = body.position;
            const quat = body.quaternion;
            let dMin = Infinity, dMax = -Infinity;

            // Iterate over all shapes in the body.
            for (let i = 0; i < body.shapes.length; i++) {
                const shape = body.shapes[i];
                const offset = body.shapeOffsets[i] || new CANNON.Vec3(0, 0, 0);
                // World-space offset of the shape centre.
                const worldOffset = quat.vmult(offset);
                const center = pos.vadd(worldOffset);
                const centerProjection = normal.dot(center.vsub(portal.position));

                // Compute the half‑extent of the shape along the portal normal.
                let halfExtent = 0;
                switch (shape.type) {
                    case CANNON.Shape.types.SPHERE:
                        halfExtent = shape.radius;
                        break;
                    case CANNON.Shape.types.BOX: {
                        const half = shape.halfExtents;
                        const localNormal = quat.inverse().vmult(normal);
                        halfExtent = Math.abs(localNormal.x) * half.x +
                                     Math.abs(localNormal.y) * half.y +
                                     Math.abs(localNormal.z) * half.z;
                        break;
                    }
                    case CANNON.Shape.types.CYLINDER: {
                        const r = Math.max(shape.radiusTop, shape.radiusBottom);
                        const h = shape.height / 2;
                        halfExtent = Math.max(r, h);
                        break;
                    }
                    case CANNON.Shape.types.CONVEXPOLYHEDRON: {
                        let maxDist = 0;
                        const vertices = shape.vertices;
                        if (vertices) {
                            for (const v of vertices) {
                                const dist = v.norm();
                                if (dist > maxDist) maxDist = dist;
                            }
                        }
                        halfExtent = maxDist || 0.5;
                        break;
                    }
                    default:
                        halfExtent = 0.5;
                }

                dMin = Math.min(dMin, centerProjection - halfExtent);
                dMax = Math.max(dMax, centerProjection + halfExtent);
            }

            // If entering from the front, the entire body has crossed when dMax <= 0.
            if (entryDirection === 'front') {
                return dMax <= 0;
            } else {
                return dMin >= 0;
            }
        }

        // ---- PLAYER: capsule trailing‑edge check ----
        const upWorld = new CANNON.Vec3(0, 1, 0);
        const upLocal = portal.rotation.inverse().vmult(upWorld);
        const halfHeight = PLAYER_HEIGHT * 0.5;
        const radius = PLAYER_RADIUS;
        const centerLocal = portal.rotation.inverse().vmult(body.position.vsub(portal.position));
        const centerZ = centerLocal.z;
        // Projection of the capsule's vertical extent onto the portal normal.
        const absUpZ = Math.abs(upLocal.z);

        if (entryDirection === 'front') {
            // Max Z extent = centerZ + halfHeight*absUpZ + radius.
            const maxZ = centerZ + halfHeight * absUpZ + radius;
            return maxZ <= 0;
        } else {
            const minZ = centerZ - halfHeight * absUpZ - radius;
            return minZ >= 0;
        }
    },

    /**
     * Performs the actual teleportation: removes the old body and creates a new one
     * at the exit portal with transformed velocity and orientation.
     * @param {string} entityId - The entity ID.
     * @param {Portal} entrancePortal - The entrance portal.
     * @param {Portal} exitPortal - The exit portal.
     * @param {CANNON.Body} masterBody - The current physics body (will be replaced).
     * @returns {void}
     */
    _performRoleSwap(entityId, entrancePortal, exitPortal, masterBody) {
        // Get the proxy data (if any) to update after the swap.
        const data = this.proxies.get(entityId);
        if (!data) return;

        // Compute the combined rotation: entrance -> exit with 180° Y mirror.
        const entranceRotInv = entrancePortal.rotation.clone().inverse();
        const combinedQuat = exitPortal.rotation.clone().mult(entranceRotInv);

        // Compute the exit position by transforming the offset from entrance centre.
        const offset = masterBody.position.vsub(entrancePortal.position);
        const localOffset = entranceRotInv.vmult(offset);
        localOffset.x *= -1;
        localOffset.z *= -1;
        const newOffset = exitPortal.rotation.vmult(localOffset);
        const exitPos = exitPortal.position.vadd(newOffset);

        // Transform velocity: mirror X and Z components in local space.
        const localVel = entranceRotInv.vmult(masterBody.velocity);
        localVel.x *= -1;
        localVel.z *= -1;
        const newVel = exitPortal.rotation.vmult(localVel);

        // Determine if the body should have fixed rotation (players fixed, blocks free).
        const fixedRotation = entityId.startsWith('block_') ? false : masterBody.fixedRotation;

        // Create a new physics body with the same properties.
        const newMaster = new CANNON.Body({
            mass: masterBody.mass,
            material: entityId.startsWith('player_') ? playerMaterial : blockMaterial,
            collisionResponse: true,
            linearDamping: masterBody.linearDamping || 0.1,
            angularDamping: masterBody.angularDamping,
            fixedRotation: fixedRotation,
            ccdSpeedThreshold: masterBody.ccdSpeedThreshold,
            ccdRadius: masterBody.ccdRadius,
        });

        // Preserve userData from the old body.
        newMaster.userData = masterBody.userData || {};

        // Copy all shapes and offsets from the old body.
        const shapes = masterBody.shapes;
        const offsets = masterBody.shapeOffsets;
        for (let i = 0; i < shapes.length; i++) {
            newMaster.addShape(shapes[i], offsets[i]);
        }

        // Set the new body's transform.
        newMaster.position.copy(exitPos);
        if (entityId.startsWith('player_')) {
            // For players, keep rotation identity (will be set by yaw/pitch update).
            newMaster.quaternion.set(0, 0, 0, 1);
        } else {
            // For blocks, keep the original quaternion (relative rotation unchanged).
            newMaster.quaternion.copy(masterBody.quaternion);
        }
        newMaster.velocity.copy(newVel);
        newMaster.angularVelocity.set(0, 0, 0);

        // Remove the old body and add the new one.
        world.removeBody(masterBody);
        world.addBody(newMaster);

        // ---- Update references in the game state ----
        if (entityId.startsWith('player_')) {
            const playerId = entityId.substring(7);
            const player = players.get(playerId);
            if (player) {
                player.body = newMaster;
                // Update yaw and pitch based on the new forward direction.
                const yawQuat = new CANNON.Quaternion().setFromAxisAngle(
                    new CANNON.Vec3(0, 1, 0), player.yaw
                );
                const pitchQuat = new CANNON.Quaternion().setFromAxisAngle(
                    new CANNON.Vec3(1, 0, 0), player.pitch
                );
                const lookQuat = yawQuat.clone().mult(pitchQuat);
                const oldForward = lookQuat.vmult(new CANNON.Vec3(0, 0, -1));
                const newForward = combinedQuat.vmult(oldForward);
                const newYaw = Math.atan2(newForward.x, newForward.z);
                const horizDist = Math.hypot(newForward.x, newForward.z);
                const newPitch = Math.atan2(newForward.y, horizDist);

                player.yaw = newYaw;
                player.pitch = newPitch;
                player.lastTeleportTime = performance.now();
                player.teleportSeq = (player.teleportSeq || 0) + 1;
                const currentSeq = player.teleportSeq;

                // Send camera orientation updates to the client.
                if (player.port) {
                    player.port.postMessage({
                        type: 'portal_camera',
                        yaw: newYaw,
                        pitch: newPitch
                    });
                    // Force a teleport sync (position, rotation, yaw, pitch, scale, sequence).
                    player.port.postMessage({
                        type: 'portal_teleport_sync',
                        position: [newMaster.position.x, newMaster.position.y, newMaster.position.z],
                        rotation: [0, 0, 0, 1],
                        yaw: newYaw,
                        pitch: newPitch,
                        scale: player.scale,
                        teleportSeq: currentSeq
                    });
                }

                // Release any players that this player was holding.
                for (const [otherId, otherPlayer] of players) {
                    if (otherPlayer.held && otherPlayer.heldBy === playerId) {
                        otherPlayer.setHeld(false);
                    }
                }
            }
        } else if (entityId.startsWith('block_')) {
            const blockId = entityId.substring(6);
            const block = blocks.get(blockId);
            if (block) {
                block.body = newMaster;
                // Ensure userData is present for pickup system.
                if (!block.body.userData) block.body.userData = { blockId: blockId };
                // Ensure the block is dynamic and can collide.
                block.body.type = CANNON.Body.DYNAMIC;
                block.body.collisionResponse = true;
                block.body.updateMassProperties();
            }
        }

        // Update the proxy data with the new master body and swapped portals.
        data.masterBody = newMaster;
        data.entrancePortal = exitPortal;
        data.exitPortal = entrancePortal;
    },

    /**
     * Computes the clone transform (position and quaternion) for a proxy.
     * Not used in the current implementation but kept for future use.
     * @param {CANNON.Body} body - The body to transform.
     * @param {Portal} entrancePortal - The entrance portal.
     * @param {Portal} exitPortal - The exit portal.
     * @returns {Object} { position: CANNON.Vec3, quaternion: CANNON.Quaternion }
     */
    _computeCloneTransform(body, entrancePortal, exitPortal) {
        const rotYQuat = new CANNON.Quaternion().setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0), Math.PI
        );
        const entranceRotInv = entrancePortal.rotation.inverse();
        const combinedQuat = exitPortal.rotation.clone().mult(rotYQuat).mult(entranceRotInv);
        const offset = body.position.vsub(entrancePortal.position);
        const newOffset = combinedQuat.vmult(offset);
        const clonePos = exitPortal.position.vadd(newOffset);
        const cloneQuat = combinedQuat.mult(body.quaternion);
        return { position: clonePos, quaternion: cloneQuat };
    },

    /**
     * Synchronises forces from proxy bodies to main bodies. Currently a no‑op.
     * @returns {void}
     */
    syncAllProxies() { /* Not used in current implementation. */ },

    /**
     * Returns the physics body for a given entity ID.
     * @param {string} entityId - The entity ID ('player_...' or 'block_...').
     * @returns {CANNON.Body|null} The body, or null if not found.
     */
    getMainBody(entityId) {
        if (entityId.startsWith('block_')) {
            const blockId = entityId.substring(6);
            const block = blocks.get(blockId);
            return block ? block.body : null;
        } else if (entityId.startsWith('player_')) {
            const playerId = entityId.substring(7);
            const player = players.get(playerId);
            return player ? player.body : null;
        }
        return null;
    },

    /**
     * Finds a portal by its ID across all players' portals.
     * @param {string} id - The portal ID.
     * @returns {Portal|null} The portal, or null if not found.
     */
    _getPortalById(id) {
        for (const [ownerId, portals] of playerPortals) {
            if (portals.blue && portals.blue.id === id) return portals.blue;
            if (portals.orange && portals.orange.id === id) return portals.orange;
        }
        return null;
    },

    /**
     * Removes all proxy entries for a given entity.
     * @param {string} entityId - The entity ID.
     * @returns {void}
     */
    removeAllProxiesForEntity(entityId) {
        this.proxies.delete(entityId);
    },
};