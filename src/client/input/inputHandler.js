/*
Author: Daniel Yu
Date: March 15, 2026
Description: Handles all keyboard and mouse input for the client. This file sets up event listeners
             for keyboard input (movement, jumping, pickups, equipping), mouse movement (yaw/pitch),
             pointer lock activation, and mouse button clicks for placing portals. It also provides
             functions to send input state to the worker and to manage the rod pickup mechanic via
             raycasting against all interactable objects.
*/

// Import the global game state (player state, camera, worker, held object state, etc.)
import { GameState } from '../clientState.js';
// Import the forced‑perspective grab mechanic for E‑key pickup and dropping.
import { ForcedPerspective } from '../mechanics/ForcedPerspective.js';
// Import the rod pickup mechanic for Q‑key pickup and dropping.
import { PortalPickup } from '../mechanics/portalMechanics/PortalPickup.js';
// Import the remote player manager to access remote player capsules for raycasting.
import { RemotePlayerManager } from '../players/RemotePlayerManager.js';
// Import Three.js core for vector and raycasting operations.
import * as THREE from 'three';

/**
 * Sets up all input event listeners for the client. This includes keyboard events (down/up),
 * pointer lock activation, mouse movement for camera control, and mouse button events for portal placement.
 * It also prevents default actions for context menus when pointer is locked.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
export function setupInput() {
    // ----- Keyboard Down Events -----
    // Listen for keydown events to update the global key state and trigger actions.
    window.addEventListener('keydown', (e) => {
        // Only process input if the pointer is locked (first‑person mode active).
        if (!GameState.controlsLocked) return;

        // Get the event code (e.g., 'KeyW', 'Space') for consistent identification.
        const key = e.code;

        // Update movement key states (WASD) for the input loop.
        if (key === 'KeyW') GameState.keyState.w = true;
        if (key === 'KeyA') GameState.keyState.a = true;
        if (key === 'KeyS') GameState.keyState.s = true;
        if (key === 'KeyD') GameState.keyState.d = true;

        // Jump (Space): update key state and prevent default page scrolling.
        if (key === 'Space') {
            GameState.keyState.space = true;
            e.preventDefault(); // Prevent the page from scrolling down.
        }

        // Forced‑perspective grab (E key): if rod pickup is active, drop it first; then toggle forced perspective.
        if (key === 'KeyE') {
            if (PortalPickup.active) PortalPickup.drop(); // Drop any rod‑held object.
            ForcedPerspective.togglePickup();             // Pick up or drop via forced perspective.
            e.preventDefault();
        }

        // Rod pickup (Q key): only works if the portal gun is equipped.
        if (key === 'KeyQ') {
            // Ensure the local character exists and is equipped.
            if (GameState.firstPersonChar && GameState.firstPersonChar.isEquipped) {
                // If something is held via forced perspective, drop it first to avoid conflicts.
                if (GameState.heldObjectId) ForcedPerspective.drop();
                // Toggle the rod pickup (pick up or drop).
                toggleRodPickup();
            }
            e.preventDefault();
        }

        // Equip/unequip portal gun (F key).
        if (key === 'KeyF') {
            if (GameState.firstPersonChar) GameState.firstPersonChar.toggleEquip();
            e.preventDefault();
        }
    });

    // ----- Keyboard Up Events -----
    // Listen for keyup events to release movement keys.
    window.addEventListener('keyup', (e) => {
        const key = e.code;
        if (key === 'KeyW') GameState.keyState.w = false;
        if (key === 'KeyA') GameState.keyState.a = false;
        if (key === 'KeyS') GameState.keyState.s = false;
        if (key === 'KeyD') GameState.keyState.d = false;
        if (key === 'Space') GameState.keyState.space = false;
    });

    // ----- Click to lock pointer -----
    // Clicking on the renderer canvas requests pointer lock to enter first‑person mode.
    GameState.renderer.domElement.addEventListener('click', () => {
        if (!GameState.controlsLocked) GameState.renderer.domElement.requestPointerLock();
    });

    // ----- Pointer lock change -----
    // Update the controlsLocked flag when pointer lock state changes.
    document.addEventListener('pointerlockchange', () => {
        GameState.controlsLocked = document.pointerLockElement === GameState.renderer.domElement;
    });

    // ----- Mouse movement (for camera rotation) -----
    // When the pointer is locked and the player is not being held by another player,
    // pass mouse movement delta to the FirstPersonCharacter to update yaw and pitch.
    document.addEventListener('mousemove', (e) => {
        if (GameState.controlsLocked && GameState.firstPersonChar && !GameState.isBeingHeld) {
            GameState.firstPersonChar.handleMouseMove(e.movementX, e.movementY);
        }
    });

    // ----- Mouse button events for portal placement -----
    window.addEventListener('mousedown', (e) => {
        if (!GameState.controlsLocked) return;
        // Left button (button 0) places a blue portal.
        if (e.button === 0) {
            placePortal('blue');
            e.preventDefault();
        }
        // Right button (button 2) places an orange portal.
        else if (e.button === 2) {
            placePortal('orange');
            e.preventDefault();
        }
    });

    // ----- Prevent context menu when pointer is locked -----
    // This prevents the right‑click context menu from appearing in first‑person mode.
    window.addEventListener('contextmenu', (e) => {
        if (GameState.controlsLocked) e.preventDefault();
    });
}

/**
 * Sends the current input state (movement keys, jump, yaw, pitch) to the physics worker.
 * This function is called periodically (every 50 ms) by the input loop.
 * It also includes the current teleport sequence number to reject stale inputs after a teleport.
 * Input is only sent if the pointer is locked and the player is not being held.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
function sendInputToWorker() {
    // Guard conditions: worker must exist, player ID assigned, pointer locked, and player not held.
    if (!GameState.worker || !GameState.playerId || !GameState.controlsLocked || GameState.isBeingHeld) return;

    // Compute forward and right input values from key states (range -1 to 1).
    const forward = (GameState.keyState.w ? 1 : 0) - (GameState.keyState.s ? 1 : 0);
    const right = (GameState.keyState.d ? 1 : 0) - (GameState.keyState.a ? 1 : 0);

    // Retrieve the current yaw (horizontal) and pitch (vertical) angles.
    const moveYaw = GameState.rawYaw;
    const movePitch = GameState.pitch;

    // Capture a timestamp for the input (though not used in the worker currently).
    const timestamp = performance.now();

    // Send the input message via the worker's message port.
    GameState.worker.port.postMessage({
        type: 'input',                           // Message type identifier.
        input: {
            move: { forward, right },            // Movement direction.
            jump: GameState.keyState.space,      // Whether jump is pressed.
            yaw: moveYaw,                        // Current yaw in radians.
            pitch: movePitch,                    // Current pitch in radians.
            timestamp,                           // Timestamp for ordering (optional).
            teleportSeq: GameState.teleportSeq   // Sequence number to reject stale inputs after teleport.
        },
    });

    // After sending the jump input, reset the space key state so it doesn't repeat.
    if (GameState.keyState.space) GameState.keyState.space = false;
}

/**
 * Starts the input loop by scheduling sendInputToWorker at a fixed interval.
 * The interval is defined in GameState.inputInterval (default 50 ms).
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
export function startInputLoop() {
    setInterval(sendInputToWorker, GameState.inputInterval);
}

/**
 * Toggles the rod pickup (Q key) mechanic. If the rod is currently active, it drops the held object.
 * Otherwise, it performs a raycast from the camera centre to find the nearest pickable object
 * (remote player capsules or blocks) and starts the rod pickup if the object is within range and not owned by another player.
 * This function is called when the Q key is pressed and the portal gun is equipped.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
function toggleRodPickup() {
    // If rod pickup is already active, drop the held object and exit.
    if (PortalPickup.active) {
        PortalPickup.drop();
        return;
    }

    // Set the raycaster to fire from the camera's centre (crosshair) in the camera's view direction.
    GameState.raycaster.setFromCamera(new THREE.Vector2(0, 0), GameState.camera);

    // Build an array of all pickable objects: remote player capsules and all block meshes.
    const allObjects = [];
    // Add remote player capsules (each has a `capsule` mesh).
    for (const player of RemotePlayerManager.remotePlayers.values()) {
        if (player.capsule) allObjects.push(player.capsule);
    }
    // Add all block meshes from the worldObjects map.
    for (const mesh of GameState.worldObjects.values()) {
        allObjects.push(mesh);
    }

    // Perform the raycast against all pickable objects.
    const intersects = GameState.raycaster.intersectObjects(allObjects);
    // If no intersection, do nothing.
    if (intersects.length === 0) return;

    // The closest hit object is at index 0.
    const hit = intersects[0].object;

    // Determine the type of object hit and start the rod pickup accordingly.
    if (hit.userData.remoteAvatarCapsule) {
        // Hit a remote player capsule: find which player this capsule belongs to.
        let playerId = null;
        for (const [id, player] of RemotePlayerManager.remotePlayers) {
            if (player.capsule === hit) { playerId = id; break; }
        }
        // If a valid player ID was found and the object can be picked up (within distance), start the pickup.
        if (playerId && PortalPickup.canPickup(hit)) {
            PortalPickup.startPickup(hit, playerId, 'player', playerId);
        }
    } else {
        // Hit a block: get its ID and owner.
        const blockId = hit.userData.id;
        // Only pick up if the block is owned by the local player or unowned, and it is within pickup range.
        if (blockId && (!hit.userData.owner || hit.userData.owner === GameState.playerId) && PortalPickup.canPickup(hit)) {
            PortalPickup.startPickup(hit, blockId, 'block');
        }
    }
}

/**
 * Places a portal of the specified type (blue or orange) at the point where the camera ray
 * intersects a valid world surface. The portal is placed on the hit surface with its forward
 * direction aligned to the surface normal (or a computed orientation for horizontal surfaces).
 * This function is called when the player clicks with the portal gun equipped.
 *
 * @param {string} type - The portal type: 'blue' or 'orange'.
 * @returns {void} - No return value.
 */
function placePortal(type) {
    // Do nothing if the local character does not exist or the gun is not equipped.
    if (!GameState.firstPersonChar || !GameState.firstPersonChar.isEquipped) return;

    // Set the raycaster to fire from the camera centre.
    GameState.raycaster.setFromCamera(new THREE.Vector2(0, 0), GameState.camera);

    // Build an array of all meshes in the scene to raycast against, excluding certain objects.
    const allObjects = [];
    GameState.scene.traverse(obj => {
        // Only consider meshes.
        if (!obj.isMesh) return;
        // Exclude local player parts (model, capsule) and remote avatar meshes.
        if (obj.userData.isLocalPlayerPart || obj.userData.remoteAvatar) return;
        // Exclude portal meshes themselves.
        if (obj.userData.isPortal) return;
        // Exclude the currently held object (if any) to avoid placing portals on it.
        if (GameState.heldObjectId && obj === GameState.heldObjectMesh) return;
        // Exclude the rod‑held object (if any).
        if (PortalPickup.active && obj === PortalPickup.heldObjectMesh) return;
        // All other meshes are valid portal surfaces.
        allObjects.push(obj);
    });

    // Perform the raycast against the scene objects.
    const hits = GameState.raycaster.intersectObjects(allObjects);
    // If no surface was hit, exit.
    if (hits.length === 0) return;

    // Get the closest hit.
    const hit = hits[0];
    const hitPoint = hit.point;                 // World‑space point of intersection.
    const hitNormal = hit.face.normal.clone();  // Local face normal.
    // Transform the normal from object local space to world space.
    hitNormal.applyQuaternion(hit.object.quaternion);
    hitNormal.normalize();

    // Determine if the hit surface is horizontal (normal mostly aligned with world Y).
    const isHorizontal = Math.abs(hitNormal.y) > 0.9;

    // Compute the portal's orientation quaternion.
    let quat;
    if (isHorizontal) {
        // For horizontal surfaces (floor/ceiling), we need a specific orientation:
        // the portal's up direction should be the surface normal, and its forward direction
        // should point away from the camera's projection onto the surface.
        const up = hitNormal.clone(); // The surface normal becomes the portal's local up.
        // Compute a vector from the hit point to the camera.
        const toCamera = GameState.camera.position.clone().sub(hitPoint);
        // Project the camera direction onto the surface plane to get a forward direction.
        const projected = toCamera.clone().sub(up.clone().multiplyScalar(toCamera.dot(up))).normalize();
        // If the projection is near zero (camera directly above the point), use a default forward.
        let forwardDir = projected.length() < 0.001 ? new THREE.Vector3(1, 0, 0) : projected;
        // Build a rotation matrix from the forward, up, and cross product to form an orthonormal basis.
        // We want the portal's Z axis to point along the forward direction, Y up, X = Y x Z.
        const yAxis = forwardDir.clone();
        const zAxis = up.clone();
        const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
        // Construct a 4x4 matrix with these axes as rows (or columns depending on convention).
        const matrix = new THREE.Matrix4().set(
            xAxis.x, yAxis.x, zAxis.x, 0,
            xAxis.y, yAxis.y, zAxis.y, 0,
            xAxis.z, yAxis.z, zAxis.z, 0,
            0, 0, 0, 1
        );
        // Extract the quaternion from the rotation matrix.
        quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
    } else {
        // For vertical surfaces, align the portal's local Z axis with the surface normal.
        quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hitNormal);
    }

    // Apply a tiny offset along the normal to prevent depth fighting (z‑fighting) with the wall.
    const offsetAmount = 0.001;
    const pos = hitPoint.clone().add(hitNormal.clone().multiplyScalar(offsetAmount));

    // Send the portal placement to the worker if we have a valid connection and player ID.
    if (GameState.worker && GameState.playerId) {
        GameState.worker.port.postMessage({
            type: 'place_portal',
            portalType: type,
            position: [pos.x, pos.y, pos.z],        // Array of three floats.
            rotation: [quat.x, quat.y, quat.z, quat.w] // Array of four floats (quaternion).
        });
    }
}