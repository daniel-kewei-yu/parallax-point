/*
Author: Daniel Yu
Date: March 15, 2026
Description: Configuration for the physics worker (Cannon.js). This file imports shared constants
             from gameConstants.js to stay in sync with the client and defines worker‑specific
             settings such as the fixed timestep and physics loop interval. The resulting CONFIG
             object is used throughout the worker code for physics parameters.
*/

// Import all shared constants from the common gameConstants file.
import {
    PLAYER_RADIUS,          // Radius of the player's collision capsule.
    PLAYER_HEIGHT,          // Total height of the player (foot to head).
    MOVE_SPEED,             // Maximum horizontal movement speed (m/s).
    JUMP_FORCE,             // Vertical velocity applied when jumping (m/s).
    ROOM_SIZE,              // Half‑size of the square room (the world spans ±ROOM_SIZE).
    WALL_HEIGHT,            // Height of the walls and ceiling.
    WALL_THICKNESS,         // Thickness of the walls.
    BLOCK_BASE_MASS,        // Base mass of a block at scale 1.
    GRAVITY                 // Acceleration due to gravity (negative Y direction).
} from '../shared/gameConstants.js';

/**
 * Worker configuration object.
 * Combines shared constants with worker‑specific physics settings.
 * All properties are derived from gameConstants or defined here.
 */
export const CONFIG = {
    // ----- Player physical properties (shared with client) -----
    /** Radius of the player's collision capsule (metres). */
    PLAYER_RADIUS,
    /** Total height of the player (metres). */
    PLAYER_HEIGHT,

    // ----- Movement physics (shared with client) -----
    /** Maximum horizontal movement speed (metres/second). */
    MOVE_SPEED,
    /** Jump impulse (vertical velocity) applied when jumping. */
    JUMP_FORCE,

    // ----- World dimensions (shared with client) -----
    /** Half‑size of the square room (metres). */
    ROOM_SIZE,
    /** Height of the walls (metres). */
    WALL_HEIGHT,
    /** Thickness of the walls (metres). */
    WALL_THICKNESS,

    // ----- Block properties (shared with client) -----
    /** Base mass of a block at scale 1 (mass scales cubically with scale). */
    BLOCK_BASE_MASS,

    // ----- Physics simulation (shared with client) -----
    /** Acceleration due to gravity (metres/second²). */
    GRAVITY,

    // ----- Worker‑specific timing settings -----
    /** Fixed timestep for the physics simulation (seconds per step). */
    FIXED_TIMESTEP: 1 / 60,          // 60 steps per second (16.67 ms per step).
    /** Interval between physics updates in milliseconds. */
    PHYSICS_INTERVAL_MS: 1000 / 60,   // 60 Hz (matches the fixed timestep).
};