/*
Author: Daniel Yu
Date: March 15, 2026
Description: Client‑specific configuration. This file imports shared constants from gameConstants.js
             and adds client‑only settings such as eye offset, model rotation offset quaternion,
             gun placement, and animation thresholds. The resulting CLIENT_CONFIG object is used
             throughout the client code for player dimensions, movement, world size, gun appearance,
             and animation parameters.
*/

// Import Three.js core for Vector3, Euler, and Quaternion.
import * as THREE from 'three';
// Import all shared constants from the common gameConstants file.
import {
    PLAYER_RADIUS,
    PLAYER_HEIGHT,
    EYE_HEIGHT,
    MOVE_SPEED,
    JUMP_FORCE,
    ROOM_SIZE,
    WALL_HEIGHT,
    WALL_THICKNESS,
    BLOCK_BASE_MASS,
    BROADCAST_INTERVAL,
    BLOCK_BROADCAST_INTERVAL,
    PUSH_COOLDOWN,
    MODEL_SCALE,
    MODEL_ROTATION_OFFSET_YAW,
    CAMERA_SMOOTH_FACTOR,
    GUN_SCALE,
    GUN_POSITION,
    GUN_ROTATION,
    EXTRA_YAW_DEGREES,
    MOVING_SPEED_THRESHOLD,
    MOVING_TIMEOUT
} from '../shared/gameConstants.js';

/**
 * Client configuration object.
 * Combines shared constants with client‑specific values.
 * All properties are derived from gameConstants or defined here.
 */
export const CLIENT_CONFIG = {
    // ----- Player physical dimensions (shared with worker) -----
    /** Radius of the player's collision capsule (metres). */
    PLAYER_RADIUS,
    /** Total height of the player (metres). */
    PLAYER_HEIGHT,
    /** Height of the eye above the foot (metres). */
    EYE_HEIGHT,

    // ----- Eye offset relative to the head bone (client‑only) -----
    /** Offset from the head bone to the actual eye position (in local head space). */
    EYE_OFFSET: new THREE.Vector3(0, -0.05, 0.05),

    // ----- Movement physics (shared with worker) -----
    /** Maximum movement speed (metres/second). */
    MOVE_SPEED,
    /** Jump impulse (vertical velocity) applied when jumping. */
    JUMP_FORCE,

    // ----- World dimensions (shared with worker) -----
    /** Half‑size of the square room (metres). */
    ROOM_SIZE,
    /** Height of the walls (metres). */
    WALL_HEIGHT,
    /** Thickness of the walls (metres). */
    WALL_THICKNESS,

    // ----- Block properties (shared with worker) -----
    /** Base mass of a block at scale 1 (used in physics). */
    BLOCK_BASE_MASS,

    // ----- Networking timing (shared with worker) -----
    /** Interval between sending input messages to worker (ms). */
    BROADCAST_INTERVAL,
    /** Interval for block state broadcasts (ms). */
    BLOCK_BROADCAST_INTERVAL,
    /** Cooldown between pushes (ms). */
    PUSH_COOLDOWN,

    // ----- Model and camera (client‑only) -----
    /** Base scale factor applied to the player model (multiplied by visual scale). */
    MODEL_SCALE,
    /** Quaternion representing the model's rotation offset (converted from yaw). */
    MODEL_ROTATION_OFFSET: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, MODEL_ROTATION_OFFSET_YAW, 0)
    ),
    /** Smoothing factor for camera interpolation (0 = no smoothing, 1 = instant). */
    CAMERA_SMOOTH_FACTOR,

    // ----- Portal gun appearance (client‑only) -----
    /** Scale of the gun model relative to its original size. */
    GUN_SCALE,
    /** Position of the gun relative to the right hand bone. */
    GUN_POSITION: new THREE.Vector3(GUN_POSITION.x, GUN_POSITION.y, GUN_POSITION.z),
    /** Rotation of the gun relative to the right hand bone (Euler angles). */
    GUN_ROTATION: new THREE.Euler(GUN_ROTATION.x, GUN_ROTATION.y, GUN_ROTATION.z),

    // ----- Animation thresholds (client‑only) -----
    /** Additional yaw added when holding the gun in the equip pose (radians). */
    EXTRA_YAW_DEGREES: EXTRA_YAW_DEGREES * Math.PI / 180,   // Convert from degrees to radians.
    /** Speed below which the player is considered standing still. */
    MOVING_SPEED_THRESHOLD,
    /** Time after which the player is considered no longer moving (seconds). */
    MOVING_TIMEOUT,
};