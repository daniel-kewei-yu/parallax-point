/*
Author: Daniel Yu
Date: March 15, 2026
Description: Centralised constants shared by both client and worker. This file eliminates duplication
             and ensures consistency between rendering and physics by defining all physical dimensions,
             movement parameters, world size, block properties, networking timing, and model/gun
             appearance values in a single location. Both the client and the physics worker import
             these constants.
*/

// ---------- Player physical properties ----------
/** Radius of the player's collision capsule (in metres). */
export const PLAYER_RADIUS = 0.4;
/** Total height of the player (in metres) from foot to top of head. */
export const PLAYER_HEIGHT = 1.85;
/** Height of the eye above the foot (in metres), used for camera placement. */
export const EYE_HEIGHT = 1.6;

// ---------- Movement & physics ----------
/** Maximum horizontal movement speed (in metres per second). */
export const MOVE_SPEED = 4.0;
/** Impulse applied when jumping (vertical velocity in metres per second). */
export const JUMP_FORCE = 6.0;
/** Acceleration due to gravity (in metres per second squared). */
export const GRAVITY = -9.82;

// ---------- World dimensions ----------
/** Half‑size of the square room (in metres); the room spans from -ROOM_SIZE to +ROOM_SIZE in X and Z. */
export const ROOM_SIZE = 100;
/** Height of the walls and ceiling (in metres). */
export const WALL_HEIGHT = 40;
/** Thickness of the walls (in metres). */
export const WALL_THICKNESS = 0.5;

// ---------- Block properties ----------
/** Base mass of a block at scale 1 (the mass scales cubically with scale). */
export const BLOCK_BASE_MASS = 50;

// ---------- Networking & timing ----------
/** Target broadcast interval (in milliseconds) – reference only, actual interval may vary. */
export const BROADCAST_INTERVAL = 30;
/** Interval for block state broadcasts (in milliseconds). */
export const BLOCK_BROADCAST_INTERVAL = 30;
/** Cooldown between pushing objects (in milliseconds). */
export const PUSH_COOLDOWN = 100;
/** Interval between sending input messages to the worker (in milliseconds). */
export const INPUT_INTERVAL = 50;

// ---------- Animation & model ----------
/** Base scale factor applied to the player model (the GLTF model is scaled by this). */
export const MODEL_SCALE = 0.0105;
/** Model rotation offset in degrees (190° around Y) to correct the model's default facing. */
export const MODEL_ROTATION_OFFSET_YAW = (190 * Math.PI) / 180;
/** Smoothing factor for camera interpolation (0 = no smoothing, 1 = instant). Not currently used. */
export const CAMERA_SMOOTH_FACTOR = 0.1;

// ---------- Gun (portal gun) appearance ----------
/** Uniform scale factor for the gun model. */
export const GUN_SCALE = 0.35;
/** Position of the gun relative to the right hand bone (in local hand space). */
export const GUN_POSITION = { x: 10, y: 30, z: 0 };
/** Rotation of the gun relative to the right hand bone (in radians, Euler angles). */
export const GUN_ROTATION = {
    x: -(10 * Math.PI) / 180,
    y: -(10 * Math.PI) / 180,
    z: 0
};

// ---------- Animation timing ----------
/** Speed threshold (in metres per second) below which the player is considered standing still. */
export const MOVING_SPEED_THRESHOLD = 0.2;
/** Time (in seconds) after the last movement before the player is considered no longer moving. */
export const MOVING_TIMEOUT = 0.3;
/** Additional yaw offset (in degrees) applied when the player is holding the gun in the equip pose. */
export const EXTRA_YAW_DEGREES = 25;