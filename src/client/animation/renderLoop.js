/*
Author: Daniel Yu
Date: March 15, 2026
Description: Defines the main rendering loop for the client. This loop runs every frame via requestAnimationFrame
             and is responsible for updating the local player model, held objects (forced perspective and rod pickups),
             crosshair hover state, and the physics capsule position. It also handles the split‑phase portal camera
             when the player's view is detached, updates portal interactions and proxies, and finally renders the
             entire scene along with the portal stencil passes.
*/

// Import client configuration constants (player dimensions, model offsets, etc.)
import { CLIENT_CONFIG } from '../clientConfig.js';
// Import the global game state singleton (scene, camera, renderer, player state, etc.)
import { GameState } from '../clientState.js';
// Import the forced‑perspective grab mechanic to update the held object's position and scale.
import { ForcedPerspective } from '../mechanics/ForcedPerspective.js';
// Import the rod pickup mechanic to update the rod‑held object's position.
import { PortalPickup } from '../mechanics/portalMechanics/PortalPickup.js';
// Import the portal manager to trigger the recursive stencil rendering of portals.
import { PortalManager } from '../mechanics/portalMechanics/PortalManager.js';
// Import the portal interaction module to update proxy creation and camera detachment logic.
import { PortalInteraction } from '../mechanics/portalMechanics/PortalInteraction.js';
// Import the portal proxy manager to update visual clones of objects crossing portals.
import { PortalProxyManager } from '../mechanics/portalMechanics/PortalProxyManager.js';
// Import the Three.js core library for vector and matrix operations.
import * as THREE from 'three';

/**
 * Starts the rendering loop by defining a recursive function that schedules itself
 * via requestAnimationFrame. This loop runs at the display's refresh rate (typically 60 Hz)
 * and performs all per‑frame updates and rendering.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
export function startRenderLoop() {
    /**
     * The recursive render function. It calls itself on every animation frame.
     * @param {void} - No parameters.
     * @returns {void} - No return value.
     */
    function renderLoop() {
        // Schedule the next frame immediately so the loop continues.
        requestAnimationFrame(renderLoop);

        // Get the time delta (in seconds) since the last frame from Three.js's built‑in clock.
        const delta = GameState.clock.getDelta();

        // Update the local player model, animations, and camera position before portal detection.
        // This ensures the model's world‑space AABB is current for proxy and crossing checks.
        if (GameState.firstPersonChar) {
            GameState.firstPersonChar.update(delta);
        }

        // If the player is holding an object via forced perspective (E key), update its position and scale.
        if (GameState.heldObjectId) {
            ForcedPerspective.updateHeldObject();
        }

        // If the rod pickup (Q key) is active, update the held object's position using raycasting and safe target clamping.
        if (PortalPickup.active) {
            PortalPickup.update();
        }

        // Update the crosshair colour based on whether a grabbable object is under the reticle.
        ForcedPerspective.updateHover();

        // Position the local player's invisible physics capsule to match the latest state from the worker.
        // This capsule is used for collision visualisation and portal‑crossing detection.
        if (GameState.physicsPlayer?.capsule && GameState.localPlayerState) {
            // Extract the foot position from the worker's state (an array of three numbers).
            const pos = new THREE.Vector3().fromArray(GameState.localPlayerState.position);
            // Get the player's current scale (default to 1 if undefined).
            const scale = GameState.localPlayerState.scale !== undefined ? GameState.localPlayerState.scale : 1;
            // Compute half the player's height multiplied by scale (capsule centre is at half height above the foot).
            const halfHeight = (CLIENT_CONFIG.PLAYER_HEIGHT / 2) * scale;
            // Set the capsule's position to the foot position plus half height on the Y axis.
            GameState.physicsPlayer.capsule.position.set(pos.x, pos.y + halfHeight, pos.z);
        }

        // ----- Split‑phase portal camera (detached mode) -----
        // When the camera is detached from the body (i.e., the eye has crossed a portal but the body hasn't),
        // we render the scene from the exit portal's perspective using a transformed view matrix.
        if (GameState.cameraDetached && GameState.detachEntrancePortal && GameState.detachExitPortal) {
            // Reference the entrance and exit portals involved in the detachment.
            const entrancePortal = GameState.detachEntrancePortal;
            const exitPortal = GameState.detachExitPortal;

            // Compute the rotation that maps the entrance portal's local space to the exit portal's local space.
            const entranceRotInv = entrancePortal.rotation.clone().invert();
            const combinedQuat = exitPortal.rotation.clone().multiply(entranceRotInv);

            // Transform the eye position (camera origin) from entrance space to exit space.
            // Get the world‑space position of the player's eye (head bone + offset).
            const eyePos = GameState.firstPersonChar.getEyeWorldPosition();
            // Compute the offset from the entrance portal's position to the eye.
            const offset = eyePos.clone().sub(entrancePortal.position);
            // Convert the offset into the entrance portal's local coordinate system.
            const localOffset = offset.clone().applyQuaternion(entranceRotInv);
            // Mirror the local X and Z coordinates (left‑right and front‑back) to simulate teleportation.
            localOffset.x *= -1;   // left‑right mirror
            localOffset.z *= -1;   // front‑back mirror
            // Transform the mirrored local offset back to world space using the exit portal's rotation.
            const newOffset = localOffset.clone().applyQuaternion(exitPortal.rotation);
            // Compute the final exit position by adding the transformed offset to the exit portal's position.
            const exitPos = exitPortal.position.clone().add(newOffset);
            // Apply the computed exit position to the camera.
            GameState.camera.position.copy(exitPos);

            // Compute the new view direction by transforming the current forward vector through the combined portal rotation.
            // Extract the current yaw and pitch (in radians) from the global state.
            const currentYaw = GameState.rawYaw;
            const currentPitch = GameState.pitch;
            // Pre‑compute trigonometric values for efficiency.
            const cp = Math.cos(currentPitch);
            const sp = Math.sin(currentPitch);
            const cy = Math.cos(currentYaw);
            const sy = Math.sin(currentYaw);
            // The old forward direction derived from yaw and pitch (assuming Y‑up, Z‑forward).
            const oldForward = new THREE.Vector3(-cp * sy, sp, -cp * cy);
            // Rotate the old forward vector by the combined portal quaternion to get the new view direction.
            const newForward = oldForward.clone().applyQuaternion(combinedQuat);

            // Convert the new forward vector back to yaw and pitch angles.
            const newYaw = Math.atan2(newForward.x, newForward.z);  // arctan(x/z) gives the horizontal angle.
            const horizDist = Math.hypot(newForward.x, newForward.z); // Projection length on the XZ plane.
            const newPitch = Math.atan2(newForward.y, horizDist);    // Vertical angle above the horizon.

            // Set the camera's quaternion using the new yaw and pitch (with the 'YXZ' order for FPS controls).
            GameState.camera.quaternion.setFromEuler(new THREE.Euler(newPitch, newYaw, 0, 'YXZ'));
        }

        // Update portal interactions: this includes creating/destroying visual proxies for objects crossing portals
        // and managing the camera detachment state based on eye‑sign changes.
        PortalInteraction.update();
        // Update all active portal proxies (clones) to match the latest transforms and clipping states.
        PortalProxyManager.updateAll();

        // Render the main scene from the current camera (which may be detached).
        GameState.renderer.render(GameState.scene, GameState.camera);
        // Perform the recursive stencil‑based portal rendering pass for all active portal pairs.
        PortalManager.render(GameState.camera);
    }

    // Start the loop by calling the render function once.
    renderLoop();
}