/*
Author: Daniel Yu
Date: March 15, 2026
Description: Provides utility functions for client‑side calculations: converting between yaw
             (rotation around the Y axis) and a quaternion, and extracting yaw from a quaternion.
             These helpers are used for model orientation, camera rotation, and remote player
             synchronisation.
*/

// Import Three.js core for quaternions, Euler angles, and vectors.
import * as THREE from 'three';

/**
 * Creates a quaternion representing a rotation around the world Y axis by the given yaw angle.
 * This is used to convert a horizontal heading (yaw) into a quaternion for model and camera orientation.
 * @param {number} yaw - The rotation angle in radians (positive = counter‑clockwise when viewed from above).
 * @returns {THREE.Quaternion} A quaternion representing the rotation around Y.
 */
export function getYawQuaternion(yaw) {
    // Create a new quaternion.
    // Use setFromEuler with an Euler angle where only the Y component is set.
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
}

/**
 * Extracts the yaw angle (rotation around the world Y axis) from a quaternion.
 * The yaw is computed by rotating the forward vector (0,0,-1) by the quaternion
 * and then calculating the angle of the resulting horizontal projection.
 * This is used when dropping held players to align them to their yaw.
 * @param {THREE.Quaternion} quat - The input quaternion to extract yaw from.
 * @returns {number} The yaw angle in radians, in the range (-π, π].
 */
export function getYawFromQuaternion(quat) {
    // Compute the forward direction: the (0,0,-1) vector rotated by the quaternion.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    // The yaw is the arctangent of the X and Z components of the forward vector.
    // This gives the angle of the horizontal projection of the forward direction.
    return Math.atan2(forward.x, forward.z);
}