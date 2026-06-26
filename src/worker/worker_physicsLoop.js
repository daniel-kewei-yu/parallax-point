/*
Author: Daniel Yu
Date: March 15, 2026
Description: Main physics loop for the SharedWorker. This module runs the fixed‑step physics simulation
             at 60 Hz, stepping the Cannon.js world, updating player physics (skipping players that are
             held or rod‑held), processing portal interactions (dual‑body sync and role swap), and
             broadcasting the full world state to all clients after each step. The loop uses an accumulator
             to handle variable frame times and maintain deterministic physics.
*/

// Import the shared physics world, players, and blocks maps from the main worker module.
import { world, players, blocks } from './physicsSharedWorker.js';
// Import configuration constants (fixed timestep, physics interval).
import { CONFIG } from './worker_config.js';
// Import the broadcast function to send state updates to clients.
import { broadcastFullState } from './worker_broadcast.js';
// Import the proxy manager for handling portal teleportation and role swaps.
import { ProxyManager } from './worker_portalProxy.js';
// Import Cannon.js for Vec3 and other utilities.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ----- Timing variables for the physics loop -----
// The timestamp of the last physics update (in milliseconds).
let lastPhysicsTime = performance.now();
// Accumulator for variable timestep: stores excess time to step multiple times if needed.
let accumulator = 0;

/**
 * The main physics loop function. It is called at a fixed interval (60 Hz) via setInterval.
 * It computes the elapsed time, caps it to prevent large jumps, and steps the physics world
 * one or more times with a fixed timestep. After each step, it processes portal interactions,
 * syncs proxy bodies, and broadcasts the full state.
 * @param {void} - No parameters.
 * @returns {void}
 */
function physicsLoop() {
    // ----- Step 1: Compute elapsed time since the last physics update -----
    const now = performance.now();
    // Calculate delta in seconds.
    let delta = (now - lastPhysicsTime) / 1000;
    // Update the last physics time.
    lastPhysicsTime = now;
    // Cap delta to a maximum of 0.2 seconds to prevent spiral-of-death if the tab was inactive.
    if (delta > 0.2) delta = 0.2;
    // Add the delta to the accumulator.
    accumulator += delta;

    // ----- Step 2: Step the physics world one or more times with a fixed timestep -----
    // While the accumulator has enough time for at least one fixed timestep, step the world.
    while (accumulator >= CONFIG.FIXED_TIMESTEP) {
        // 2a. Update player physics – skip players that are held (forced perspective) or rod‑held (Q).
        // These players are controlled by the spring‑damper forces or kinematic motion, so we skip
        // their normal physics update to avoid interference.
        for (const player of players.values()) {
            // Skip held players (forced perspective E) and rod‑held players (Q).
            if (player.held || player.rodHeld) continue;
            // Update the player's physics (movement, jumping, etc.) for this timestep.
            player.updatePhysics(CONFIG.FIXED_TIMESTEP);
        }

        // 2b. Step the entire physics world with the fixed timestep.
        // This advances the simulation, applying forces, collisions, and constraints.
        world.step(CONFIG.FIXED_TIMESTEP);

        // 2c. Post‑step updates for players (skip held and rod‑held).
        // This includes ground detection, collision response restoration, and `wasDropped` handling.
        for (const player of players.values()) {
            // Skip held players (forced perspective E) and rod‑held players (Q).
            if (player.held || player.rodHeld) continue;
            // Run post‑step logic (e.g., re‑enabling collision response after jump).
            player.postStep();
            // Update ground status (raycasts to determine if the player is on the ground).
            player.updateGroundStatus();
        }

        // 2d. Update portal interactions: detects when objects (players/blocks) cross portal planes
        // and performs role swaps (teleportation) when the trailing edge passes.
        // This is handled by the ProxyManager, which tracks pending swaps and executes them.
        ProxyManager.updatePortalInteractions();

        // 2e. Sync forces from proxy bodies to main bodies.
        // Currently a no‑op (the proxy bodies are not used in the current implementation),
        // but kept for potential future use.
        ProxyManager.syncAllProxies();

        // 2f. Subtract one fixed timestep from the accumulator.
        accumulator -= CONFIG.FIXED_TIMESTEP;
    }

    // ----- Step 3: Broadcast the full world state to all connected clients -----
    // After stepping the world, send the updated state to every client.
    // This includes all blocks, players, and portals.
    broadcastFullState();
}

/**
 * Starts the physics loop by scheduling the physicsLoop function at a fixed interval.
 * The interval is defined in CONFIG.PHYSICS_INTERVAL_MS (default: 1000/60 ≈ 16.67 ms).
 * This ensures the physics runs at a consistent 60 Hz regardless of rendering frame rate.
 * @param {void} - No parameters.
 * @returns {void}
 */
export function startPhysicsLoop() {
    // Use setInterval to call physicsLoop every PHYSICS_INTERVAL_MS milliseconds.
    setInterval(physicsLoop, CONFIG.PHYSICS_INTERVAL_MS);
}