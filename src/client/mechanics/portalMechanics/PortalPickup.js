/*
Author: Daniel Yu
Date: March 15, 2026
Description: Implements the "rod" pickup mechanic for the portal gun. When the player presses Q,
             the object under the crosshair is picked up at a fixed distance from the camera.
             The held object's position is updated via raycasting to prevent it from entering geometry
             (safe target clamping). The target position is sent to the physics worker each frame,
             which applies spring‑damper forces to smoothly move the object. The rod can hold both
             blocks and remote players. When dropped, the object retains its horizontal momentum
             (the worker handles the `wasDropped` flag) until it hits a static surface.
*/

// Import Three.js core for vector and raycasting operations.
import * as THREE from 'three';
// Import the global game state singleton.
import { GameState } from '../../clientState.js';
// Import the remote player manager to access remote player capsules and avatars.
import { RemotePlayerManager } from '../../players/RemotePlayerManager.js';
// Import client configuration constants (player dimensions, etc.).
import { CLIENT_CONFIG } from '../../clientConfig.js';

/**
 * Singleton object that manages the rod pickup (Q key) mechanic.
 * It stores the held object's mesh, ID, type, and provides methods to start, update, and drop the pickup.
 */
export const PortalPickup = {
    // Whether the rod pickup is currently active.
    active: false,
    // The mesh of the object currently held by the rod.
    heldObjectMesh: null,
    // The unique ID of the held object (block ID or player ID).
    heldObjectId: null,
    // The type of the held object: 'block' or 'player'.
    heldObjectType: null,
    // If the held object is a player, this stores the player ID.
    heldPlayerId: null,
    // If the held object is a player, this stores the capsule mesh (for collision representation).
    heldObjectCapsule: null,
    // If the held object is a player, this stores the avatar model (for rendering).
    heldObjectAvatar: null,
    // The fixed distance from the camera at which the object is held.
    fixedDistance: 0,
    // The bounding box of the held object (computed once at pickup for size estimation).
    boundingBox: null,
    // The previous position of the held object (used internally, currently unused but reserved).
    previousPos: new THREE.Vector3(),
    // A dedicated raycaster for the rod pickup to avoid interfering with other raycasts.
    raycaster: new THREE.Raycaster(),

    /**
     * Computes the half‑extent of an object along a given direction.
     * This is used to determine how far to offset the object from a surface to avoid intersection.
     * The half‑extent is computed from the object's oriented bounding box projected onto the direction.
     * @param {THREE.Object3D} objectMesh - The mesh of the object (used to compute the bounding box).
     * @param {THREE.Vector3} direction - The direction (should be normalised) along which to compute the extent.
     * @returns {number} The half‑extent (distance from the centre to the outer face) along that direction.
     */
    _halfExtentAlong(objectMesh, direction) {
        // Compute the world‑space bounding box of the object.
        const box = new THREE.Box3().setFromObject(objectMesh);
        // Get the size of the bounding box (width, height, depth).
        const size = box.getSize(new THREE.Vector3());
        // The half‑extent along the given direction is the sum of the half‑sizes multiplied by the absolute direction components.
        return 0.5 * (
            Math.abs(size.x * direction.x) +
            Math.abs(size.y * direction.y) +
            Math.abs(size.z * direction.z)
        );
    },

    /**
     * Casts a ray from `origin` along `direction` up to `maxDist` and returns the distance to the first hit,
     * ignoring the held object, player parts, portals, and remote player avatars.
     * This is used to find the nearest surface in the direction of the ray, so the held object can be placed just before it.
     * @param {THREE.Vector3} origin - The world‑space origin of the ray.
     * @param {THREE.Vector3} direction - The normalised direction of the ray.
     * @param {number} maxDist - The maximum distance to check.
     * @returns {Object} An object containing { distance: number, normal: THREE.Vector3|null }.
     *                    The distance is the distance to the first obstacle (or maxDist if none),
     *                    and the normal is the surface normal at the hit point (or null if no hit).
     */
    _safeRay(origin, direction, maxDist) {
        // Build an array of all meshes in the scene to test against, excluding certain objects.
        const obstacles = [];
        GameState.scene.traverse(obj => {
            // Only consider meshes.
            if (!obj.isMesh) return;
            // Exclude portal meshes (they should not block the rod).
            if (obj.userData.isPortal) return;
            // Exclude the object currently held by the rod.
            if (obj === this.heldObjectMesh) return;
            // Exclude remote player avatar meshes (they are visual only; the capsule is used for collision).
            if (obj.userData.remoteAvatar) return;
            // Exclude local player parts (model, capsule) to avoid self‑intersection.
            if (obj.userData.isLocalPlayerPart) return;
            // All other meshes are potential obstacles.
            obstacles.push(obj);
        });

        // Set up the raycaster with the given origin, direction, and far limit.
        this.raycaster.set(origin, direction);
        this.raycaster.far = maxDist;
        // Perform the intersection test.
        const hits = this.raycaster.intersectObjects(obstacles);

        // If there is a hit, return the distance (minus a small epsilon to avoid touching) and the normal.
        if (hits.length > 0) {
            return {
                distance: Math.max(0, hits[0].distance - 0.01),
                normal: hits[0].face.normal.clone(),
            };
        }
        // If no hit, return the maximum distance and null normal.
        return { distance: maxDist, normal: null };
    },

    /**
     * Starts the rod pickup for the given object. The object is picked up at its current distance from the camera.
     * The worker is notified of the pickup, and the active flag is set.
     * @param {THREE.Mesh} objectMesh - The mesh of the object to pick up (block or player capsule).
     * @param {string} objectId - The unique ID of the object (block ID or player ID).
     * @param {string} objectType - 'block' or 'player'.
     * @param {string|null} playerId - If the object is a player, this is the player ID; otherwise null.
     * @returns {void}
     */
    startPickup(objectMesh, objectId, objectType, playerId = null) {
        // If a rod pickup is already active, drop it first to avoid conflicts.
        if (this.active) this.drop();

        // Get the camera position and forward direction.
        const cameraPos = GameState.camera.position.clone();
        const cameraForward = new THREE.Vector3(0, 0, -1)
            .applyQuaternion(GameState.camera.quaternion)
            .normalize();

        // Compute the distance from the camera to the object at the moment of pickup.
        const objectPos = objectMesh.position.clone();
        const pickupDistance = cameraPos.distanceTo(objectPos);
        // Store this as the fixed distance for the duration of the pickup.
        this.fixedDistance = pickupDistance;

        // Store the object references.
        this.heldObjectMesh = objectMesh;
        this.heldObjectId = objectId;
        this.heldObjectType = objectType;
        this.heldPlayerId = playerId;

        // Compute and store the bounding box for later size calculations.
        this.boundingBox = new THREE.Box3().setFromObject(objectMesh);
        // Store the initial position (for future comparisons, though currently unused).
        this.previousPos.copy(objectPos);

        // If the object is a player, store references to its capsule and avatar.
        if (objectType === 'player') {
            const player = RemotePlayerManager.remotePlayers.get(playerId);
            if (player) {
                this.heldObjectCapsule = player.capsule;
                this.heldObjectAvatar = player.avatar;
            }
        }

        // ---- Send pickup message to the worker (without teleport) ----
        // The worker will set up the spring‑damper and zero friction for the object.
        if (objectType === 'block' && GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({
                type: 'pickup_rod',
                objectId,
                // No initialTarget – the object stays at its current position.
            });
        } else if (objectType === 'player' && GameState.worker && GameState.playerId) {
            // For players, we send the player ID; the worker will handle the rod‑held state.
            GameState.worker.port.postMessage({
                type: 'pickup_player_rod',
                playerId,
                // No initialTarget – the player stays at its current position.
            });
        }

        // Set the active flags.
        this.active = true;
        GameState.rodPickupActive = true;
    },

    /**
     * Drops the rod‑held object. Sends the final position, rotation, and scale to the worker,
     * which releases the object and (for players) sets the `wasDropped` flag to retain momentum.
     * Resets all internal state.
     * @returns {void}
     */
    drop() {
        // If no pickup is active, do nothing.
        if (!this.active) return;

        // Send the drop message to the worker with the current transform of the held object.
        if (this.heldObjectType === 'block' && GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({
                type: 'drop_rod',
                objectId: this.heldObjectId,
                position: this.heldObjectMesh.position.toArray(),
                rotation: this.heldObjectMesh.quaternion.toArray(),
                scale: this.heldObjectMesh.scale.x,
            });
        } else if (this.heldObjectType === 'player' && GameState.worker && GameState.playerId) {
            // For players, we need to convert the centre position (capsule position) back to foot position.
            const scale = this.heldObjectMesh.scale.x;
            // The capsule centre is at (foot + halfHeight) where halfHeight = PLAYER_HEIGHT/2 * scale.
            const halfHeight = CLIENT_CONFIG.PLAYER_HEIGHT * 0.5 * scale;
            const footPos = this.heldObjectMesh.position.clone()
                .sub(new THREE.Vector3(0, halfHeight, 0));
            GameState.worker.port.postMessage({
                type: 'drop_player_rod',
                playerId: this.heldPlayerId,
                position: footPos.toArray(),
                rotation: this.heldObjectMesh.quaternion.toArray(),
                scale: scale,
            });
        }

        // Reset all internal state.
        this.active = false;
        this.heldObjectMesh = null;
        this.heldObjectId = null;
        this.heldObjectType = null;
        this.heldPlayerId = null;
        this.heldObjectCapsule = null;
        this.heldObjectAvatar = null;
        this.boundingBox = null;
        GameState.rodPickupActive = false;
    },

    /**
     * Updates the rod‑held object's position every frame. It computes a safe target position
     * by raycasting from the camera along the view direction and clamping the object's position
     * to just before the first obstacle. The target is sent to the worker, which applies
     * the spring‑damper forces.
     * @returns {void}
     */
    update() {
        // If the rod pickup is not active or there is no held object, do nothing.
        if (!this.active || !this.heldObjectMesh) return;

        // Ensure the raycaster has a reference to the camera (for setFromCamera).
        this.raycaster.camera = GameState.camera;

        // Get the camera position and forward direction.
        const cameraPos = GameState.camera.position.clone();
        const cameraForward = new THREE.Vector3(0, 0, -1)
            .applyQuaternion(GameState.camera.quaternion)
            .normalize();

        // ---------- Compute a safe target via raycast ----------
        // The full target position is the camera position plus the forward direction scaled by the fixed distance.
        const fullTarget = cameraPos.clone().add(
            cameraForward.clone().multiplyScalar(this.fixedDistance)
        );

        // The direction from the camera to the full target.
        const toTarget = fullTarget.clone().sub(cameraPos);
        const rayDist = toTarget.length();
        const rayDir = toTarget.normalize();

        // Compute the half‑extent of the held object along the ray direction.
        // This is the distance from the object's centre to its outer surface along that direction.
        const halfExt = this._halfExtentAlong(this.heldObjectMesh, rayDir);

        // Cast a ray from the camera along the view direction, with an additional length equal to the half‑extent.
        // This ensures we detect surfaces that would be inside the object if placed at the full target.
        const hit = this._safeRay(cameraPos, rayDir, rayDist + halfExt);

        // Compute the safe target position.
        let safeTarget;
        if (hit.normal) {
            // If a surface was hit, place the object just before the surface (offset by the half‑extent along the ray).
            safeTarget = new THREE.Vector3()
                .copy(cameraPos)
                .add(rayDir.clone().multiplyScalar(hit.distance))
                .sub(rayDir.clone().multiplyScalar(halfExt));
        } else {
            // If no surface was hit, use the full target.
            safeTarget = fullTarget.clone();
        }

        // --- FLOOR CLAMP REMOVED – object will slide naturally with zero friction ---
        // The worker applies zero friction, so the object will slide along surfaces without additional clamping.

        // Send the target position to the worker, converting centre to foot for players.
        if (GameState.worker && GameState.playerId) {
            if (this.heldObjectType === 'block') {
                GameState.worker.port.postMessage({
                    type: 'update_held_rod',
                    objectId: this.heldObjectId,
                    position: safeTarget.toArray(),
                });
            } else if (this.heldObjectType === 'player') {
                // For players, the capsule mesh position is at the centre of the capsule.
                // The worker expects the foot position, so we need to subtract half height.
                const scale = this.heldObjectMesh.scale.x; // capsule scale
                const halfHeight = CLIENT_CONFIG.PLAYER_HEIGHT * 0.5 * scale;
                const footPos = safeTarget.clone().sub(
                    new THREE.Vector3(0, halfHeight, 0)
                );
                GameState.worker.port.postMessage({
                    type: 'update_held_player_rod',
                    playerId: this.heldPlayerId,
                    position: footPos.toArray(),
                });
            }
        }
    },

    /**
     * Checks whether an object can be picked up by the rod (within maximum distance).
     * The maximum distance is scaled by the local player's scale to maintain consistency.
     * @param {THREE.Object3D} objectMesh - The mesh of the object to test.
     * @returns {boolean} True if the object is within pickup range, false otherwise.
     */
    canPickup(objectMesh) {
        // Ensure we have local player state to get the scale.
        if (!GameState.localPlayerState) return false;

        // Get the camera position and the object's position.
        const cameraPos = GameState.camera.position.clone();
        const objectPos = objectMesh.position.clone();

        // Compute the distance.
        const distance = cameraPos.distanceTo(objectPos);

        // The maximum pickup distance is scaled by the local player's scale.
        const playerScale = GameState.localPlayerState.scale || 1;
        const maxPickupDistance = 50 * playerScale; // 50 units base distance.

        // Return true if within range.
        return distance <= maxPickupDistance;
    },
};