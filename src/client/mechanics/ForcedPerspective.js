/*
Author: Daniel Yu
Date: March 15, 2026
Description: Implements the forced-perspective grab mechanic. When the player presses the E key,
             the crosshair changes colour if a grabbable object (block or remote player) is within
             range and not owned by another player. Pressing E again picks up the closest object
             under the crosshair, regardless of type (block or player). The held object is positioned
             at a distance determined by casting a dense grid of rays through the object's screen‑space
             bounds, and its scale is adjusted proportionally with distance to simulate perspective.
             A debug ray visualisation (corner rays only) can be enabled by setting showRays = true.
             The held object's transform is sent to the physics worker each frame for synchronisation.
*/

// Import Three.js core for vectors, matrices, and raycasting.
import * as THREE from 'three';
// Import client configuration (player dimensions, model scale, etc.).
import { CLIENT_CONFIG } from '../clientConfig.js';
// Import the global game state singleton.
import { GameState } from '../clientState.js';
// Import the remote player manager to access remote player capsules and avatars.
import { RemotePlayerManager } from '../players/RemotePlayerManager.js';
// Import utility to extract yaw from a quaternion (used when dropping players).
import { getYawFromQuaternion } from '../clientUtils.js';
// Import block helper update function to keep the yellow AABB wireframe current when a block is held.
import { blockBoxHelpers, updateBlockHelper } from '../mechanics/blockManager.js';

// Toggle debug rays visualisation (set to false to hide the corner rays).
const showRays = true;

/**
 * Singleton object that manages all forced‑perspective pickup operations.
 */
export const ForcedPerspective = {
    /** @type {THREE.Group|null} - Group containing debug ray visualisations. */
    _rayGroup: null,

    /**
     * Computes the half‑extents of an object in its local space by iterating over all child meshes
     * and computing their bounding boxes relative to the object's local coordinate system.
     * This is used to determine the size of the held object for collision detection and scaling.
     * @param {THREE.Object3D} obj - The object to measure (can be a group with multiple meshes).
     * @returns {THREE.Vector3} Half-extents (x, y, z) in local units.
     */
    computeLocalHalfExtents(obj) {
        // Create an empty bounding box to accumulate child bounding boxes.
        const box = new THREE.Box3();
        box.makeEmpty();

        // Traverse all children of the object.
        obj.traverse(child => {
            // Only consider meshes with geometry.
            if (!child.isMesh || !child.geometry) return;
            // Ensure the child's geometry has a bounding box.
            if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();

            // Compute the transformation matrix from the child's local space to the parent object's local space.
            const relMatrix = new THREE.Matrix4();
            let cur = child;
            while (cur && cur !== obj) {
                relMatrix.premultiply(cur.matrix);
                cur = cur.parent;
            }

            // Clone the child's bounding box and transform it by the relative matrix.
            const childBox = child.geometry.boundingBox.clone().applyMatrix4(relMatrix);
            // Union it with the accumulated box.
            box.union(childBox);
        });

        // If the box is empty (no meshes found), return a default half-extent of 0.5.
        if (box.isEmpty()) return new THREE.Vector3(0.5, 0.5, 0.5);
        // Get the size of the box and return half the size.
        const size = new THREE.Vector3();
        box.getSize(size);
        return size.multiplyScalar(0.5);
    },

    /**
     * Computes the screen‑space bounding box of an object by projecting all its world‑space vertices
     * through the camera. This is used to determine which screen positions to raycast through
     * when positioning the held object.
     * @param {THREE.Object3D} obj - The object to project.
     * @returns {Object} An object with minX, maxX, minY, maxY in normalized device coordinates (-1 to 1).
     */
    computeScreenBounds(obj) {
        // Ensure the object's world matrices are up to date.
        obj.updateMatrixWorld(true);

        // Collect all world‑space vertices if the object is a mesh with a position attribute.
        const vertices = [];
        if (obj.isMesh && obj.geometry && obj.geometry.attributes.position) {
            const position = obj.geometry.attributes.position;
            const worldMat = obj.matrixWorld;
            // Iterate over every vertex of the geometry.
            for (let i = 0; i < position.count; i++) {
                const v = new THREE.Vector3().fromBufferAttribute(position, i);
                v.applyMatrix4(worldMat); // Transform to world space.
                vertices.push(v);
            }
        }

        // If vertices were collected, project them to screen space and compute the min/max NDC coordinates.
        if (vertices.length > 0) {
            let minX = 1, maxX = -1, minY = 1, maxY = -1;
            vertices.forEach(world => {
                // Project the world point to normalized device coordinates.
                const screen = world.clone().project(GameState.camera);
                // Update the bounds.
                minX = Math.min(minX, screen.x);
                maxX = Math.max(maxX, screen.x);
                minY = Math.min(minY, screen.y);
                maxY = Math.max(maxY, screen.y);
            });
            return { minX, maxX, minY, maxY };
        }
        // Fallback: return a default (should not happen if the mesh has vertices).
        return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    },

    /**
     * Updates the position and scale of the currently held object (called every frame).
     * It projects the held object's screen‑space bounds, casts a dense grid of rays through those bounds,
     * finds the closest obstacle hit, and positions the object just before that obstacle.
     * The scale is adjusted to maintain the perspective effect.
     * @returns {void}
     */
    updateHeldObject() {
        // If there is no held object mesh, do nothing.
        if (!GameState.heldObjectMesh) return;

        // If the held object is a player, ensure we use the capsule mesh for raycasting (not the avatar).
        if (GameState.heldObjectType === 'player') {
            GameState.heldObjectMesh = GameState.heldObjectCapsule;
        }

        // Update the held object's rotation to match the camera with a relative offset.
        GameState.heldObjectMesh.quaternion.copy(
            GameState.camera.quaternion
        ).multiply(GameState.holdRelativeRotation);

        // Compute the screen‑space bounds of the held object.
        const bounds = this.computeScreenBounds(GameState.heldObjectMesh);
        // Compute the width and height of the bounds in NDC.
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;

        // Build a list of obstacle meshes to raycast against.
        // Exclude debug rays, portals, the held object itself, and local player parts.
        const obstacles = [];
        GameState.scene.traverse(obj => {
            if (!obj.isMesh) return;
            // Skip debug rays.
            if (obj.userData.isDebugRay) return;
            // Skip portals.
            if (obj.userData.isPortal) return;
            // Skip the currently held object.
            if (obj === GameState.heldObjectMesh) return;
            // If the held object is a player, skip its capsule.
            if (GameState.heldObjectType === 'player' && obj === GameState.heldObjectCapsule) return;
            // Include remote player capsules and any other non‑local meshes.
            if (obj.userData.remoteAvatarCapsule) obstacles.push(obj);
            else if (!obj.userData.isLocalPlayerPart && !obj.userData.remoteAvatar) obstacles.push(obj);
        });

        // Get the camera forward direction (unit vector).
        const forward = new THREE.Vector3(0, 0, -1)
            .applyQuaternion(GameState.camera.quaternion)
            .normalize();
        // Compute the inverse quaternion of the held object (to transform directions into local space).
        const invObjQuat = GameState.heldObjectMesh.quaternion.clone().invert();
        // Transform the camera forward direction into the object's local space.
        const u = forward.clone().applyQuaternion(invObjQuat);

        // Retrieve the half-extents of the held object and the distance/scale at which it was picked up.
        const halfExtents = GameState.holdLockedHalfExtents ?? new THREE.Vector3(0.5, 0.5, 0.5);
        const distScale = GameState.holdLockedScale / GameState.holdLockedDistance;
        // Compute the local half-extents scaled by the current distance-to-scale ratio.
        const kVec = halfExtents.clone().multiplyScalar(distScale);

        // Define a grid resolution (32x32) to cast rays through the screen bounds.
        const gridSize = 32;
        const stepX = width / (gridSize - 1);
        const stepY = height / (gridSize - 1);
        // Initialize the minimum candidate distance to infinity.
        let minCandidate = Infinity;

        // ---- Debug ray visualisation (corner rays only) ----
        if (showRays) {
            // If the ray group does not exist, create it and add it to the scene.
            if (!this._rayGroup) {
                this._rayGroup = new THREE.Group();
                GameState.scene.add(this._rayGroup);
            }
            // Clear any old debug rays from the group.
            while (this._rayGroup.children.length > 0) {
                this._rayGroup.remove(this._rayGroup.children[0]);
            }
        }
        // A small sphere geometry for hit point visualisation.
        const sphereGeo = new THREE.SphereGeometry(0.08, 8, 8);

        // Iterate over the grid in screen space.
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                // Compute the NDC coordinate for this grid cell.
                const ndcX = bounds.minX + i * stepX;
                const ndcY = bounds.minY + j * stepY;
                // Create a raycaster from the camera through this NDC point.
                const ray = new THREE.Raycaster();
                ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), GameState.camera);
                // Intersect with the obstacle list.
                const intersects = ray.intersectObjects(obstacles);

                let hitPoint = null;
                if (intersects.length > 0) {
                    // If a hit occurred, get the closest hit point.
                    hitPoint = intersects[0].point;
                    // Compute the distance from the camera to the hit point.
                    const D = GameState.camera.position.distanceTo(hitPoint);
                    // Get the ray direction (normalised).
                    const r = ray.ray.direction.clone().normalize();
                    // Transform the ray direction into the object's local space.
                    const b = r.clone().applyQuaternion(invObjQuat);

                    // For each axis, compute the required scaling (L_min) to place the object just before the hit.
                    let L_min = Infinity;
                    for (let axis = 0; axis < 3; axis++) {
                        const bi = b.getComponent(axis);
                        // If the component is near zero, skip (parallel to axis).
                        if (Math.abs(bi) < 1e-6) continue;
                        const ui = u.getComponent(axis);
                        const ki = kVec.getComponent(axis);
                        let Li;
                        // Solve for L such that the object's face touches the hit point.
                        if (bi > 0) Li = (ki + ui) / bi;
                        else Li = (ui - ki) / bi;
                        if (Li > 0 && Li < L_min) L_min = Li;
                    }
                    // If a valid L_min was found, compute the candidate distance: D / L_min.
                    if (L_min !== Infinity) {
                        const candidate = D / L_min;
                        if (candidate < minCandidate) minCandidate = candidate;
                    }
                }

                // Draw debug rays only for the four corners of the grid.
                const isCorner =
                    (i === 0 && j === 0) ||
                    (i === gridSize - 1 && j === 0) ||
                    (i === 0 && j === gridSize - 1) ||
                    (i === gridSize - 1 && j === gridSize - 1);

                if (showRays && isCorner) {
                    // Ray origin: camera position.
                    const rayOrigin = GameState.camera.position.clone();
                    // Ray direction.
                    const rayDir = ray.ray.direction.clone();
                    // Far point at 50 units.
                    const farPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(50));
                    // End point: hit point if exists, otherwise far point.
                    const end = hitPoint ? hitPoint.clone() : farPoint;

                    // Choose colour: yellow if hit, cyan if clear.
                    const color = hitPoint ? 0xffff00 : 0x00ffff;
                    const mat = new THREE.LineBasicMaterial({
                        color,
                        depthTest: false,   // Always visible.
                        depthWrite: false,
                    });
                    // Create a line from origin to end.
                    const geo = new THREE.BufferGeometry().setFromPoints([rayOrigin, end]);
                    const line = new THREE.Line(geo, mat);
                    line.userData.isDebugRay = true;
                    this._rayGroup.add(line);

                    // If there was a hit, draw a red sphere at the hit point.
                    if (hitPoint) {
                        const sphereMat = new THREE.MeshBasicMaterial({
                            color: 0xff0000,
                            depthTest: false,
                            depthWrite: false,
                        });
                        const sphere = new THREE.Mesh(sphereGeo, sphereMat);
                        sphere.position.copy(hitPoint);
                        sphere.userData.isDebugRay = true;
                        this._rayGroup.add(sphere);
                    }
                }
            }
        }

        // If no candidate was found (no hits), set a large default distance.
        if (minCandidate === Infinity) minCandidate = 100.0;

        // Subtract a small epsilon to avoid intersection.
        const epsilon = 0.001;
        let centerDist = minCandidate - epsilon;
        // Enforce a minimum distance to prevent the object from being too close.
        const minDist = 0.2;
        centerDist = Math.max(minDist, centerDist);

        // Compute the new position: camera position + forward * centerDist.
        let newPos = GameState.camera.position.clone()
            .add(forward.clone().multiplyScalar(centerDist));
        // Compute the new scale: lockedScale * (centerDist / lockedDistance).
        const newScale = GameState.holdLockedScale * (centerDist / GameState.holdLockedDistance);

        // Apply the new position and scale to the held object.
        GameState.heldObjectMesh.position.copy(newPos);
        GameState.heldObjectMesh.scale.set(newScale, newScale, newScale);

        // If the held object is a block, update its yellow AABB wireframe helper.
        if (GameState.heldObjectType === 'block' && GameState.heldObjectId) {
            updateBlockHelper(GameState.heldObjectMesh);
        }

        // If the held object is a player, also update the avatar to match the capsule's transform.
        if (GameState.heldObjectType === 'player' && GameState.heldObjectAvatar) {
            GameState.heldObjectAvatar.position.copy(newPos);
            GameState.heldObjectAvatar.quaternion.copy(GameState.heldObjectMesh.quaternion);
            const totalScale = CLIENT_CONFIG.MODEL_SCALE * newScale;
            GameState.heldObjectAvatar.scale.set(totalScale, totalScale, totalScale);
        }

        // Send the updated transform to the physics worker.
        if (GameState.worker && GameState.playerId && GameState.heldObjectId) {
            if (GameState.heldObjectType === 'block') {
                // For blocks, send position, scale, and rotation.
                GameState.worker.port.postMessage({
                    type: 'update_held',
                    objectId: GameState.heldObjectId,
                    position: newPos.toArray(),
                    scale: newScale,
                    rotation: GameState.heldObjectMesh.quaternion.toArray(),
                });
            } else if (GameState.heldObjectType === 'player') {
                // For players, the worker expects the foot position.
                // The capsule centre is at (foot + offsetY * scale), so subtract the offset.
                const footPos = newPos.clone().sub(
                    new THREE.Vector3(0, GameState.heldObjectOriginalOffsetY * newScale, 0)
                );
                GameState.worker.port.postMessage({
                    type: 'update_held_player',
                    playerId: GameState.heldPlayerId,
                    position: footPos.toArray(),
                    rotation: GameState.heldObjectMesh.quaternion.toArray(),
                    scale: newScale,
                });
            }
        }
    },

    /**
     * Attempts to pick up the closest object under the crosshair.
     * Combines player capsules and block meshes into one raycast and picks the nearest intersection.
     * If something is already held, drops it first.
     * @returns {void}
     */
    togglePickup() {
        // If something is already held, drop it and exit.
        if (GameState.heldObjectId) {
            this.drop();
            return;
        }

        // Set the raycaster from the camera centre.
        GameState.raycaster.setFromCamera(new THREE.Vector2(0, 0), GameState.camera);

        // Combine all pickable targets: remote player capsules and block meshes.
        const allTargets = [];
        // Add remote player capsules.
        for (const player of RemotePlayerManager.remotePlayers.values()) {
            if (player.capsule) allTargets.push(player.capsule);
        }
        // Add all block meshes.
        for (const mesh of GameState.worldObjects.values()) {
            allTargets.push(mesh);
        }

        // Perform the raycast.
        const intersects = GameState.raycaster.intersectObjects(allTargets);
        if (intersects.length === 0) return;

        // The closest intersection wins.
        const hit = intersects[0].object;

        // Determine the type of object hit.
        if (hit.userData.remoteAvatarCapsule) {
            // Hit a remote player capsule: find the player ID.
            let playerId = null;
            for (const [id, player] of RemotePlayerManager.remotePlayers) {
                if (player.capsule === hit) {
                    playerId = id;
                    break;
                }
            }
            if (playerId) {
                this.pickupPlayer(playerId);
            }
        } else {
            // Hit a block: only pick up if owned by local player or unowned.
            if (!hit.userData.owner || hit.userData.owner === GameState.playerId) {
                this.pickupBlock(hit);
            }
        }
    },

    /**
     * Picks up a block. Stores the block mesh, sets up relative rotation, locked scale and distance,
     * and sends a pickup message to the worker.
     * @param {THREE.Mesh} blockMesh - The block mesh to pick up.
     * @returns {void}
     */
    pickupBlock(blockMesh) {
        // Store references.
        GameState.heldObjectMesh = blockMesh;
        GameState.heldObjectId = blockMesh.userData.id;
        GameState.heldObjectType = 'block';

        // Compute the relative rotation: inverse of camera quaternion * block quaternion.
        const cameraQuat = GameState.camera.quaternion.clone();
        const invCameraQuat = cameraQuat.invert();
        GameState.holdRelativeRotation.copy(invCameraQuat.multiply(blockMesh.quaternion.clone()));

        // Store the locked scale, distance, and half‑extents for perspective scaling.
        GameState.holdLockedScale = blockMesh.scale.x;
        GameState.holdLockedDistance = Math.max(GameState.camera.position.distanceTo(blockMesh.position), 0.001);
        GameState.holdLockedHalfExtents = this.computeLocalHalfExtents(blockMesh);

        // Set the block's owner to the local player.
        blockMesh.userData.owner = GameState.playerId;

        // Send pickup message to worker.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({
                type: 'pickup',
                objectId: GameState.heldObjectId,
                rotation: blockMesh.quaternion.toArray(),
            });
        }
    },

    /**
     * Picks up a remote player. Stores references to the capsule and avatar,
     * sets up the relative rotation, locked scale and distance, and sends a message to the worker.
     * @param {string} playerId - ID of the player to pick up.
     * @returns {void}
     */
    pickupPlayer(playerId) {
        // Retrieve the remote player data.
        const player = RemotePlayerManager.remotePlayers.get(playerId);
        if (!player) return;

        // Store references.
        GameState.heldObjectCapsule = player.capsule;
        GameState.heldObjectAvatar = player.avatar;
        GameState.heldObjectOriginalOffsetY = player.offsetY;
        GameState.heldObjectId = playerId;
        GameState.heldObjectType = 'player';
        GameState.heldPlayerId = playerId;

        GameState.heldObjectMesh = player.capsule;

        // Make the avatar visible and the capsule semi‑transparent while held.
        player.avatar.visible = true;
        player.capsule.material.transparent = true;
        player.capsule.material.opacity = 0.5;

        // Compute relative rotation from the carrier's orientation to the player's avatar.
        const carrierQuat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(GameState.pitch, GameState.rawYaw, 0, 'YXZ')
        );
        const invCarrier = carrierQuat.clone().invert();
        GameState.holdRelativeRotation.copy(invCarrier.multiply(player.avatar.quaternion.clone()));

        // Store locked scale, distance, and half‑extents.
        GameState.holdLockedScale = player.capsule.scale.x;
        GameState.holdLockedDistance = Math.max(
            GameState.camera.position.distanceTo(player.capsule.position),
            0.001
        );
        GameState.holdLockedHalfExtents = this.computeLocalHalfExtents(player.capsule);

        // Compute the foot position (capsule centre minus offsetY * scale).
        const footPos = player.avatar.position.clone().sub(
            new THREE.Vector3(0, player.offsetY, 0)
        );
        // Send pickup_player message to worker.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({
                type: 'pickup_player',
                playerId: playerId,
                position: footPos.toArray(),
                rotation: player.capsule.quaternion.toArray(),
            });
        }
    },

    /**
     * Drops the currently held object. Removes debug rays, restores the object's physics
     * (or player's held state), sends a drop message to the worker, and clears all internal state.
     * For blocks, it adjusts the final position to avoid intersecting the local player.
     * For players, it adjusts the position and rotation to avoid intersection and aligns the yaw.
     * @returns {void}
     */
    drop() {
        // If nothing is held, do nothing.
        if (!GameState.heldObjectMesh) return;

        // Remove debug rays if they exist.
        if (this._rayGroup) {
            GameState.scene.remove(this._rayGroup);
            this._rayGroup = null;
        }

        // Capture the final transform of the held object.
        const finalPos = GameState.heldObjectMesh.position.clone();
        const finalScale = GameState.heldObjectMesh.scale.x;
        let finalRot = GameState.heldObjectMesh.quaternion.clone();

        // If holding a player, restore capsule opacity and adjust rotation to align yaw.
        if (GameState.heldObjectType === 'player') {
            // Restore the capsule to semi‑transparent (or fully opaque? use 0.5 as before).
            if (GameState.heldObjectCapsule?.material) {
                GameState.heldObjectCapsule.material.transparent = true;
                GameState.heldObjectCapsule.material.opacity = 0.5;
            }
            // Remove the model rotation offset to extract the yaw.
            const invModelOffset = CLIENT_CONFIG.MODEL_ROTATION_OFFSET.clone().invert();
            const baseRot = invModelOffset.multiply(finalRot);
            const yaw = getYawFromQuaternion(baseRot);
            // Set rotation to only yaw (pitch and roll zeroed).
            finalRot.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
        }

        // Adjust the final position to avoid intersection with the local player.
        if (GameState.heldObjectType === 'block') {
            this.adjustBlockForPlayer(finalPos, finalRot, finalScale);
        } else if (GameState.heldObjectType === 'player') {
            this.adjustPlayerForCollision(finalPos, finalScale);
        }

        // Send drop message to worker.
        if (GameState.worker && GameState.playerId) {
            if (GameState.heldObjectType === 'block') {
                GameState.worker.port.postMessage({
                    type: 'drop',
                    objectId: GameState.heldObjectId,
                    position: finalPos.toArray(),
                    scale: finalScale,
                    rotation: finalRot.toArray(),
                });
            } else {
                // For players, send the final yaw separately.
                const yaw = getYawFromQuaternion(finalRot);
                GameState.worker.port.postMessage({
                    type: 'drop_player',
                    playerId: GameState.heldPlayerId,
                    position: finalPos.toArray(),
                    rotation: finalRot.toArray(),
                    scale: finalScale,
                    finalYaw: yaw,
                });
            }
        }

        // Clear all internal state.
        GameState.heldObjectId = null;
        GameState.heldObjectMesh = null;
        GameState.heldObjectType = null;
        GameState.heldPlayerId = null;
        GameState.heldObjectCapsule = null;
        GameState.heldObjectAvatar = null;
        GameState.heldObjectOriginalOffsetY = 0;
        GameState.holdRelativeRotation.set(0, 0, 0, 1);
        GameState.holdLockedHalfExtents = new THREE.Vector3(0.5, 0.5, 0.5);
        GameState.forcedPerspectiveActive = false;
    },

    /**
     * Adjusts a block's final position when dropped to avoid intersecting the local player.
     * If the block overlaps the player's capsule, it is pushed out along the axis with the least overlap.
     * @param {THREE.Vector3} targetPos - The desired position of the block (will be modified).
     * @param {THREE.Quaternion} targetRot - The desired rotation (not used in this function).
     * @param {number} targetScale - The block's scale (assumed uniform).
     * @returns {void}
     */
    adjustBlockForPlayer(targetPos, targetRot, targetScale) {
        // If no local player state, skip.
        if (!GameState.localPlayerState) return;
        // Get the player's foot position.
        const playerPos = new THREE.Vector3().fromArray(GameState.localPlayerState.position);
        // Compute half the block size (assuming cubic block for simplicity).
        const half = targetScale / 2;
        // Compute block min and max (axis‑aligned bounding box).
        const blockMin = targetPos.clone().sub(new THREE.Vector3(half, half, half));
        const blockMax = targetPos.clone().add(new THREE.Vector3(half, half, half));
        // Compute player capsule bounds (cylinder approximated by box).
        const playerMin = new THREE.Vector3(playerPos.x - CLIENT_CONFIG.PLAYER_RADIUS, playerPos.y, playerPos.z - CLIENT_CONFIG.PLAYER_RADIUS);
        const playerMax = new THREE.Vector3(playerPos.x + CLIENT_CONFIG.PLAYER_RADIUS, playerPos.y + CLIENT_CONFIG.PLAYER_HEIGHT, playerPos.z + CLIENT_CONFIG.PLAYER_RADIUS);

        // Check for overlap.
        if (blockMax.x > playerMin.x && blockMin.x < playerMax.x &&
            blockMax.y > playerMin.y && blockMin.y < playerMax.y &&
            blockMax.z > playerMin.z && blockMin.z < playerMax.z) {
            // Compute overlaps on each axis.
            const overlapX = Math.min(blockMax.x, playerMax.x) - Math.max(blockMin.x, playerMin.x);
            const overlapY = Math.min(blockMax.y, playerMax.y) - Math.max(blockMin.y, playerMin.y);
            const overlapZ = Math.min(blockMax.z, playerMax.z) - Math.max(blockMin.z, playerMin.z);
            // Push out along the axis with the smallest overlap.
            if (overlapX < overlapY && overlapX < overlapZ) {
                targetPos.x += (targetPos.x < playerPos.x ? -overlapX : overlapX);
            } else if (overlapY < overlapX && overlapY < overlapZ) {
                targetPos.y += (targetPos.y < playerPos.y ? -overlapY : overlapY);
            } else {
                targetPos.z += (targetPos.z < playerPos.z ? -overlapZ : overlapZ);
            }
        }
    },

    /**
     * Adjusts a player's final position when dropped to avoid intersecting the local player.
     * Similar to adjustBlockForPlayer but uses the player's capsule dimensions.
     * @param {THREE.Vector3} targetPos - The desired position (foot position) – will be modified.
     * @param {number} targetScale - The player's scale.
     * @returns {void}
     */
    adjustPlayerForCollision(targetPos, targetScale) {
        if (!GameState.localPlayerState) return;
        const playerPos = new THREE.Vector3().fromArray(GameState.localPlayerState.position);
        // Approximate the dropped player as a box with half‑size = scale/2.
        const half = targetScale / 2;
        const playerMin = new THREE.Vector3(playerPos.x - CLIENT_CONFIG.PLAYER_RADIUS, playerPos.y, playerPos.z - CLIENT_CONFIG.PLAYER_RADIUS);
        const playerMax = new THREE.Vector3(playerPos.x + CLIENT_CONFIG.PLAYER_RADIUS, playerPos.y + CLIENT_CONFIG.PLAYER_HEIGHT, playerPos.z + CLIENT_CONFIG.PLAYER_RADIUS);
        const heldMin = targetPos.clone().sub(new THREE.Vector3(half, half, half));
        const heldMax = targetPos.clone().add(new THREE.Vector3(half, half, half));

        if (heldMax.x > playerMin.x && heldMin.x < playerMax.x &&
            heldMax.y > playerMin.y && heldMin.y < playerMax.y &&
            heldMax.z > playerMin.z && heldMin.z < playerMax.z) {
            const overlapX = Math.min(heldMax.x, playerMax.x) - Math.max(heldMin.x, playerMin.x);
            const overlapY = Math.min(heldMax.y, playerMax.y) - Math.max(heldMin.y, playerMin.y);
            const overlapZ = Math.min(heldMax.z, playerMax.z) - Math.max(heldMin.z, playerMin.z);
            if (overlapX < overlapY && overlapX < overlapZ) {
                targetPos.x += (targetPos.x < playerPos.x ? -overlapX : overlapX);
            } else if (overlapY < overlapX && overlapY < overlapZ) {
                targetPos.y += (targetPos.y < playerPos.y ? -overlapY : overlapY);
            } else {
                targetPos.z += (targetPos.z < playerPos.z ? -overlapZ : overlapZ);
            }
        }
    },

    /**
     * Updates the crosshair colour based on whether a grabbable object is under the reticle.
     * If the pointer is locked and nothing is held, it raycasts against remote player capsules and blocks.
     * If a grabbable object is found (owned by local player or unowned), the crosshair turns green;
     * if it's owned by another player, it turns red; otherwise white.
     * @returns {void}
     */
    updateHover() {
        // If the camera doesn't exist, skip.
        if (!GameState.firstPersonChar?.camera) return;
        // If pointer is not locked or an object is already held, show default white.
        if (!GameState.controlsLocked || GameState.heldObjectId) {
            GameState.crosshair.style.backgroundColor = 'rgba(255,255,255,0.3)';
            GameState.crosshair.style.borderColor = 'rgba(255,255,255,0.8)';
            return;
        }
        // Set the raycaster from the camera centre.
        GameState.raycaster.setFromCamera(new THREE.Vector2(0, 0), GameState.camera);

        // Combine targets: remote player capsules and block meshes (excluding the held object).
        const allTargets = [];
        for (const player of RemotePlayerManager.remotePlayers.values()) {
            if (player.capsule) allTargets.push(player.capsule);
        }
        const blockMeshes = Array.from(GameState.worldObjects.values()).filter(mesh => mesh !== GameState.heldObjectMesh);
        allTargets.push(...blockMeshes);

        // Perform the raycast.
        const intersects = GameState.raycaster.intersectObjects(allTargets);
        if (intersects.length > 0) {
            const hit = intersects[0].object;
            // If it's a remote player capsule, show green (always grabbable).
            if (hit.userData.remoteAvatarCapsule) {
                GameState.crosshair.style.backgroundColor = 'rgba(0,255,0,0.5)';
                GameState.crosshair.style.borderColor = '#0f0';
            } else {
                // If it's a block, check ownership.
                if (!hit.userData.owner || hit.userData.owner === GameState.playerId) {
                    GameState.crosshair.style.backgroundColor = 'rgba(0,255,0,0.5)';
                    GameState.crosshair.style.borderColor = '#0f0';
                    GameState.hoveredObject = hit;
                } else {
                    GameState.crosshair.style.backgroundColor = 'rgba(255,0,0,0.3)';
                    GameState.crosshair.style.borderColor = '#f00';
                }
            }
            return;
        }

        // Default: white crosshair.
        GameState.crosshair.style.backgroundColor = 'rgba(255,255,255,0.3)';
        GameState.crosshair.style.borderColor = 'rgba(255,255,255,0.8)';
    },
};