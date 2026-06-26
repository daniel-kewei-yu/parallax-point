/*
Author: Daniel Yu
Date: March 15, 2026
Description: Handlers for worker messages. This module processes all incoming client messages
             related to player input, forced‑perspective pickup (E key), and rod pickup (Q key).
             The rod pickup uses mass‑scaled spring‑damper forces so that tiny blocks behave as
             smoothly as large ones. Drop handlers no longer zero velocity, allowing the object
             to retain momentum. The `wasDropped` flag is set when a player is dropped by the rod
             so they keep horizontal momentum until they hit a static surface. Zero‑friction material
             is used for rod‑held objects to allow smooth sliding.
*/

// Import shared state (players, blocks, world, materials) from the main worker module.
import { players, blocks, world, blockMaterial, playerMaterial } from './physicsSharedWorker.js';
// Import configuration constants (block base mass, etc.).
import { CONFIG } from './worker_config.js';
// Import Cannon.js for Vec3 and other physics utilities.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// Constants for spring‑damper forces used in rod pickup.
// These are accelerations (force per unit mass) applied to pull the object to the target.
const HELD_SPRING_ACCEL = 500;    // Spring constant (acceleration per metre of error).
const HELD_DAMPING_ACCEL = 50;    // Damping constant (acceleration per metre/second of velocity).

// Zero‑friction material for rod‑held objects (allows smooth sliding).
const zeroFrictionMat = new CANNON.Material({ friction: 0 });

// ========== Input handler ==========

/**
 * Processes an input message from a client. Updates the player's movement direction,
 * jump state, yaw, pitch, and equip state. Also rejects stale inputs by checking
 * the teleport sequence number and timestamp.
 * @param {string} playerId - The ID of the player sending the input.
 * @param {Object} input - The input object from the client.
 * @param {Object} input.move - Movement direction: { forward, right } (each -1 to 1).
 * @param {boolean} input.jump - Whether the jump key is pressed.
 * @param {number} input.yaw - Current yaw angle in radians.
 * @param {number} input.pitch - Current pitch angle in radians.
 * @param {number} input.timestamp - Timestamp of the input (for ordering).
 * @param {number} input.teleportSeq - Teleport sequence number (to reject stale inputs).
 * @returns {void}
 */
export function handleInput(playerId, input) {
    // Retrieve the player from the players map.
    const player = players.get(playerId);
    if (!player) return;

    // Reject inputs with stale teleport sequence number.
    // If the input's sequence is less than the player's current sequence, it's stale.
    const inputSeq = input.teleportSeq;
    if (inputSeq !== undefined && player.teleportSeq !== undefined && inputSeq < player.teleportSeq) {
        return; // Stale input – ignore.
    }

    // Reject inputs with a stale timestamp (if the timestamp is older than the last teleport).
    const timestamp = input.timestamp;
    if (timestamp !== undefined && player.lastTeleportTime !== undefined && timestamp < player.lastTeleportTime) return;

    // Update movement input.
    if (input.move) {
        player.input.forward = input.move.forward;
        player.input.right = input.move.right;
    }
    // Update jump state.
    if (input.jump) player.input.jump = true;
    // Update equip state (if provided).
    if (input.equip !== undefined) player.isEquipped = input.equip;
    // Update yaw and pitch.
    if (input.yaw !== undefined) player.yaw = input.yaw;
    if (input.pitch !== undefined) player.pitch = input.pitch;
}

// ========== Forced‑perspective pickup (E) – unchanged ==========

/**
 * Handles a forced‑perspective pickup (E key) for a block.
 * The block becomes kinematic and is owned by the player.
 * @param {string} playerId - ID of the player picking up the block.
 * @param {string} objectId - ID of the block to pick up.
 * @param {Array} rotation - The block's rotation as [x, y, z, w] quaternion.
 * @returns {void}
 */
export function handlePickup(playerId, objectId, rotation) {
    const player = players.get(playerId);
    const block = blocks.get(objectId);
    // Only pick up if the player exists, the block exists, and the block is unowned.
    if (player && block && !block.owner) {
        // Set the block's owner to the player.
        block.owner = player.id;
        // Store the block ID on the player.
        player.heldObjectId = block.id;
        // Make the block kinematic (mass=0, position controlled by client).
        block.body.mass = 0;
        block.body.type = CANNON.Body.KINEMATIC;
        block.body.collisionResponse = false;
        block.body.updateMassProperties();
        // Store the rotation (the client will control position and scale separately).
        block.heldRot = rotation;
    }
}

/**
 * Handles a forced‑perspective drop (E key) for a block.
 * The block becomes dynamic and is released from the player's control.
 * @param {string} playerId - ID of the player dropping the block.
 * @param {Array} position - The position to place the block [x, y, z].
 * @param {number} scale - The scale of the block.
 * @param {Array} rotation - The rotation as [x, y, z, w] quaternion.
 * @returns {void}
 */
export function handleDrop(playerId, position, scale, rotation) {
    const player = players.get(playerId);
    // Only drop if the player exists and is holding a block.
    if (player && player.heldObjectId) {
        const block = blocks.get(player.heldObjectId);
        if (block) {
            // Release ownership.
            block.owner = null;
            player.heldObjectId = null;
            // Set the block's scale (rebuilds shape and updates mass).
            block.setScale(scale);
            // Make the block dynamic again.
            block.body.type = CANNON.Body.DYNAMIC;
            block.body.mass = CONFIG.BLOCK_BASE_MASS * Math.pow(scale, 3);
            block.body.collisionResponse = true;
            block.body.updateMassProperties();
            // Set the block's transform.
            block.body.position.set(position[0], position[1], position[2]);
            block.body.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
            // Stop any residual velocity.
            block.body.velocity.set(0, 0, 0);
            block.body.angularVelocity.set(0, 0, 0);
            // Clear held transform data.
            player.heldPos = player.heldRot = player.heldScale = null;
            block.heldPos = block.heldRot = block.heldScale = null;
        }
    }
}

/**
 * Updates the transform of a forced‑perspective held block.
 * The block's position and rotation are set directly (kinematic).
 * @param {string} playerId - ID of the player holding the block.
 * @param {Array} pos - The new position [x, y, z].
 * @param {number} scale - The new scale.
 * @param {Array} rot - The new rotation [x, y, z, w] quaternion.
 * @returns {void}
 */
export function updateHeldObject(playerId, pos, scale, rot) {
    const player = players.get(playerId);
    if (player && player.heldObjectId) {
        const block = blocks.get(player.heldObjectId);
        if (block) {
            // Update stored transform data.
            block.heldPos = pos;
            block.heldRot = rot;
            block.heldScale = scale;
            player.heldPos = pos;
            player.heldRot = rot;
            player.heldScale = scale;
            // Apply the transform directly to the physics body (kinematic).
            block.body.position.set(pos[0], pos[1], pos[2]);
            block.body.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
        }
    }
}

// ========== Rod pickup handlers (Q) – mass‑scaled spring‑damper ==========

/**
 * Handles a rod pickup (Q key) for a block.
 * The block remains dynamic but is driven by spring‑damper forces.
 * A zero‑friction material is applied for smooth sliding.
 * @param {string} playerId - ID of the player picking up the block.
 * @param {string} objectId - ID of the block to pick up.
 * @returns {void}
 */
export function handlePickupRod(playerId, objectId) {
    const player = players.get(playerId);
    const block = blocks.get(objectId);
    // Only pick up if the player exists, the block exists, and the block is unowned.
    if (player && block && !block.owner) {
        // Set the block's owner to the player.
        block.owner = player.id;
        // Store the block ID on the player.
        player.heldObjectId = objectId;

        // The block stays dynamic but with fixed rotation (no spinning).
        block.body.type = CANNON.Body.DYNAMIC;
        block.body.collisionResponse = true;
        block.body.fixedRotation = true;
        block.body.angularVelocity.set(0, 0, 0);
        block.body.updateMassProperties();

        // ---- Set zero friction for smooth sliding ----
        // Store the original material so we can restore it later.
        block.body.userData._originalMaterial = block.body.material;
        block.body.material = zeroFrictionMat;

        // ---- Do NOT set position – keep current position ----
        // The block stays where it is; the spring will pull it to the target.
        block.body.velocity.set(0, 0, 0);

        // Initialise the target to the block's current position.
        block.heldTarget = new CANNON.Vec3(
            block.body.position.x,
            block.body.position.y,
            block.body.position.z
        );
    }
}

/**
 * Updates the rod‑held block's position by applying spring‑damper forces.
 * Called every frame by the client's update_held_rod messages.
 * @param {string} playerId - ID of the player holding the block.
 * @param {string} objectId - ID of the block.
 * @param {Array} position - The target position [x, y, z] (foot position for players).
 * @returns {void}
 */
export function updateHeldRod(playerId, objectId, position) {
    const player = players.get(playerId);
    const block = blocks.get(objectId);
    // Only update if the player exists, the block exists, and the player owns the block.
    if (!player || !block || player.heldObjectId !== objectId) return;

    // Set the target position.
    const targetPos = new CANNON.Vec3(position[0], position[1], position[2]);
    block.heldTarget = targetPos;

    // Compute the error (difference between target and current position).
    const currentPos = block.body.position;
    const error = targetPos.vsub(currentPos);

    // Compute spring force: F_spring = mass * spring_accel * error.
    const springForce = error.scale(block.body.mass * HELD_SPRING_ACCEL);
    // Compute damping force: F_damping = -mass * damping_accel * velocity.
    const dampingForce = block.body.velocity.scale(-block.body.mass * HELD_DAMPING_ACCEL);
    // Total force = spring + damping.
    let totalForce = springForce.vadd(dampingForce);

    // Compensate for gravity so the object doesn't fall.
    const gravityCompensation = world.gravity.clone().scale(-block.body.mass);
    totalForce = totalForce.vadd(gravityCompensation);

    // Apply the force to the block's body at its current position.
    block.body.applyForce(totalForce, currentPos);
    // Prevent rotation (fixedRotation is true, but this ensures it stays still).
    block.body.angularVelocity.set(0, 0, 0);
}

/**
 * Handles a rod drop (Q key) for a block.
 * The block is released and becomes fully dynamic with normal friction.
 * @param {string} playerId - ID of the player dropping the block.
 * @param {string} objectId - ID of the block to drop.
 * @param {Array} position - The position to place the block [x, y, z].
 * @param {number} scale - The scale of the block.
 * @param {Array} rotation - The rotation as [x, y, z, w] quaternion.
 * @returns {void}
 */
export function handleDropRod(playerId, objectId, position, scale, rotation) {
    const player = players.get(playerId);
    // Only drop if the player exists and owns this block.
    if (!player || player.heldObjectId !== objectId) return;
    const block = blocks.get(objectId);
    if (!block) return;

    // Release ownership.
    block.owner = null;
    player.heldObjectId = null;

    // ---- Restore original material (removes zero friction) ----
    if (block.body.userData._originalMaterial) {
        block.body.material = block.body.userData._originalMaterial;
        delete block.body.userData._originalMaterial;
    }

    // Set the block's scale and make it fully dynamic.
    block.setScale(scale);
    block.body.type = CANNON.Body.DYNAMIC;
    block.body.mass = CONFIG.BLOCK_BASE_MASS * Math.pow(scale, 3);
    block.body.fixedRotation = false;
    block.body.collisionResponse = true;
    block.body.updateMassProperties();

    // Set the block's transform.
    block.body.position.set(position[0], position[1], position[2]);
    block.body.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);

    // Clear held transform data.
    player.heldPos = player.heldRot = player.heldScale = null;
    block.heldPos = block.heldRot = block.heldScale = null;
    block.heldTarget = null;

    // Note: velocity is NOT zeroed, so the block retains its momentum when dropped.
}

// ========== Player rod pickups – mass‑scaled spring‑damper ==========

/**
 * Handles a rod pickup (Q key) for a player.
 * The player remains dynamic but is driven by spring‑damper forces.
 * A zero‑friction material is applied for smooth sliding.
 * @param {string} playerId - ID of the player doing the pickup.
 * @param {string} targetPlayerId - ID of the player to pick up.
 * @returns {void}
 */
export function handlePickupPlayerRod(playerId, targetPlayerId) {
    const targetPlayer = players.get(targetPlayerId);
    // Only pick up if the target player exists and is not already held.
    if (targetPlayer && !targetPlayer.held && !targetPlayer.rodHeld) {
        // Set the rod-held state.
        targetPlayer.rodHeld = true;
        targetPlayer.rodHeldBy = playerId;
        // Prevent rotation while held.
        targetPlayer.body.fixedRotation = true;
        targetPlayer.body.angularVelocity.set(0, 0, 0);

        // ---- Set zero friction ----
        // Store the original material so we can restore it later.
        targetPlayer.body.userData._originalMaterial = targetPlayer.body.material;
        targetPlayer.body.material = zeroFrictionMat;

        // ---- Do NOT set position – keep current position ----
        targetPlayer.body.velocity.set(0, 0, 0);

        // Initialise the target to the player's current position.
        targetPlayer.heldTarget = new CANNON.Vec3(
            targetPlayer.body.position.x,
            targetPlayer.body.position.y,
            targetPlayer.body.position.z
        );
    }
}

/**
 * Updates the rod‑held player's position by applying spring‑damper forces.
 * Called every frame by the client's update_held_player_rod messages.
 * @param {string} playerId - ID of the player holding the target.
 * @param {string} targetPlayerId - ID of the player being held.
 * @param {Array} position - The target position [x, y, z] (foot position).
 * @returns {void}
 */
export function updateHeldPlayerRod(playerId, targetPlayerId, position) {
    const targetPlayer = players.get(targetPlayerId);
    // Only update if the target player exists and is rod‑held.
    if (!targetPlayer || !targetPlayer.rodHeld) return;

    // Set the target position.
    const targetPos = new CANNON.Vec3(position[0], position[1], position[2]);
    targetPlayer.heldTarget = targetPos;

    // Compute the error (difference between target and current position).
    const currentPos = targetPlayer.body.position;
    const error = targetPos.vsub(currentPos);

    // Compute spring force: F_spring = mass * spring_accel * error.
    const springForce = error.scale(targetPlayer.body.mass * HELD_SPRING_ACCEL);
    // Compute damping force: F_damping = -mass * damping_accel * velocity.
    const dampingForce = targetPlayer.body.velocity.scale(-targetPlayer.body.mass * HELD_DAMPING_ACCEL);
    // Total force = spring + damping.
    let totalForce = springForce.vadd(dampingForce);

    // Compensate for gravity so the player doesn't fall.
    const gravityCompensation = world.gravity.clone().scale(-targetPlayer.body.mass);
    totalForce = totalForce.vadd(gravityCompensation);

    // Apply the force to the player's body at its current position.
    targetPlayer.body.applyForce(totalForce, currentPos);
    // Prevent rotation.
    targetPlayer.body.angularVelocity.set(0, 0, 0);
}

/**
 * Handles a rod drop (Q key) for a player.
 * The player is released and becomes fully dynamic with normal friction.
 * The `wasDropped` flag is set to preserve horizontal momentum until hitting a static surface.
 * @param {string} playerId - ID of the player doing the drop.
 * @param {string} targetPlayerId - ID of the player being dropped.
 * @param {Array} position - The position to place the player [x, y, z] (foot position).
 * @param {Array} rotation - The rotation as [x, y, z, w] quaternion.
 * @param {number} scale - The player's scale.
 * @param {number} finalYaw - The final yaw angle to apply.
 * @returns {void}
 */
export function handleDropPlayerRod(playerId, targetPlayerId, position, rotation, scale, finalYaw) {
    const targetPlayer = players.get(targetPlayerId);
    // Only drop if the target player exists and is rod‑held.
    if (!targetPlayer || !targetPlayer.rodHeld) return;

    // Release rod-held state.
    targetPlayer.rodHeld = false;
    targetPlayer.rodHeldBy = null;
    // Allow rotation again.
    targetPlayer.body.fixedRotation = false;

    // ---- Restore original material ----
    if (targetPlayer.body.userData._originalMaterial) {
        targetPlayer.body.material = targetPlayer.body.userData._originalMaterial;
        delete targetPlayer.body.userData._originalMaterial;
    }

    // Set the player's transform.
    targetPlayer.body.position.set(position[0], position[1], position[2]);
    targetPlayer.body.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    targetPlayer.body.collisionResponse = true;

    // Apply final yaw and scale.
    if (finalYaw !== undefined) targetPlayer.yaw = finalYaw;
    if (scale !== undefined) targetPlayer.setScale(scale);

    // Set the wasDropped flag so the player retains horizontal momentum until hitting a static surface.
    targetPlayer.wasDropped = true;
    targetPlayer.heldTarget = null;
}