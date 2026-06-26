/*
Author: Daniel Yu
Date: March 15, 2026
Description: Defines the Player class for the physics worker. Each player has a Cannon.js body
             with a capsule shape (two spheres and a box). The class handles movement, jumping,
             ground detection, scaling, being held by another player (forced perspective), and
             being grabbed by the portal rod (Q key). Rod‑held players remain dynamic and are
             driven by spring‑damper forces via velocity (not kinematic). When a player is dropped
             (thrown) via the rod, they retain horizontal momentum until they collide with a
             static surface (using the `wasDropped` flag).
*/

// Import Cannon.js for physics bodies, shapes, and vector/math utilities.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
// Import the shared world and player material from the main worker module.
import { world, playerMaterial } from './physicsSharedWorker.js';
// Import configuration constants (player radius, height, move speed, jump force, etc.).
import { CONFIG } from './worker_config.js';

/**
 * Represents a player in the physics world.
 * Each player has a capsule-shaped collision body (cylinder + two spheres) and state
 * for movement, jumping, ground detection, and being held (by other players or the rod).
 */
export class Player {
    /**
     * Constructs a new player at the given position.
     * @param {string} id - Unique player ID (e.g., 'p_5').
     * @param {Object} position - Spawn position with {x, y, z} in world coordinates.
     */
    constructor(id, position) {
        // Unique player ID.
        this.id = id;
        // Client token used for reconnection.
        this.clientToken = null;
        // Current scale factor (default 1.0).
        this.scale = 1.0;

        // ----- Create the physics body -----
        // Mass = 70 kg (standard human-ish), fixed rotation (no tilting) initially.
        this.body = new CANNON.Body({
            mass: 70,
            material: playerMaterial,
            fixedRotation: true,
            linearDamping: 0,        // No linear damping; we control velocity directly.
            angularDamping: 0.1,
        });
        // Store the player ID in userData for identification.
        this.body.userData = { playerId: this.id };

        // Remove any default shapes and build the capsule shapes.
        while (this.body.shapes.length) this.body.removeShape(this.body.shapes[0]);

        // Store radius and height for shape construction.
        this.radius = CONFIG.PLAYER_RADIUS;
        this.height = CONFIG.PLAYER_HEIGHT;
        // Build the capsule (two spheres + a box) at the current scale.
        this.buildCollisionShapes(this.radius, this.height);

        // Set the initial position.
        this.body.position.set(position.x, position.y, position.z);
        // Enable CCD (continuous collision detection) for fast-moving objects.
        this.body.ccdSpeedThreshold = 0.2;
        this.body.ccdRadius = this.radius * 0.8;

        // Add the body to the physics world.
        world.addBody(this.body);

        // ----- State variables -----
        // Ground detection flags.
        this.onGround = false;
        this.wasOnGround = false;
        // Jump cooldown (prevent jumping again mid-air).
        this.canJump = true;

        // Input state (updated by handleInput).
        this.input = { forward: 0, right: 0, jump: false };
        // Orientation (yaw and pitch) sent from client.
        this.yaw = 0;
        this.pitch = 0;

        // Equip state (portal gun).
        this.isEquipped = false;
        this.inHoldPose = false;

        // Forced‑perspective (E) hold: block ID held by this player.
        this.heldObjectId = null;
        // Velocity array for broadcasting.
        this.velocity = [0, 0, 0];

        // Forced‑perspective hold data (position, rotation, scale of held object).
        this.heldPos = null;
        this.heldRot = null;

        // Forced‑perspective held state (by another player).
        this.held = false;
        this.heldBy = null;

        // Rod (Q) hold state.
        this.rodHeld = false;
        this.rodHeldBy = null;
        this.heldTarget = null;   // Target position for spring‑damper.

        // Camera orientation when held (for the holder's view).
        this.cameraYaw = 0;
        this.cameraPitch = 0;

        // Flag to track if the player just jumped (for networking).
        this.jumped = false;

        // Counter to temporarily disable collision response after jumping.
        this.disableCollisionFrames = 0;

        // Timestamp of the last teleport (to reject stale inputs).
        this.lastTeleportTime = 0;

        // True when the player has just been dropped by the rod (Q) and
        // should keep their horizontal momentum until they hit a static surface.
        this.wasDropped = false;
    }

    /**
     * Builds the collision shapes for the player: a capsule represented by two spheres and a box.
     * The capsule is oriented upright (along Y).
     * @param {number} radius - Collision radius.
     * @param {number} height - Full height (including the spheres at top and bottom).
     * @returns {void}
     */
    buildCollisionShapes(radius, height) {
        // The cylinder part: height = total height - 2 * radius.
        const cylinderHeight = height - radius * 2;

        // Bottom sphere (at y = radius).
        const bottomSphere = new CANNON.Sphere(radius);
        this.body.addShape(bottomSphere, new CANNON.Vec3(0, radius, 0));

        // Middle box (cylinder approximated by a box with rounded corners – we use a box for simplicity).
        // Width/depth = 0.95 * 2*radius to avoid interpenetration with spheres.
        const midBoxHeight = cylinderHeight;
        const midBox = new CANNON.Box(new CANNON.Vec3(radius * 0.95, midBoxHeight / 2, radius * 0.95));
        this.body.addShape(midBox, new CANNON.Vec3(0, radius + midBoxHeight / 2, 0));

        // Top sphere (at y = height - radius).
        const topSphere = new CANNON.Sphere(radius);
        this.body.addShape(topSphere, new CANNON.Vec3(0, height - radius, 0));
    }

    /**
     * Sets the player's scale, rebuilding collision shapes and updating mass.
     * @param {number} newScale - New scale factor (must be > 0).
     * @returns {void}
     */
    setScale(newScale) {
        if (newScale === this.scale) return;
        this.scale = Math.max(newScale, 0.01);
        // Remove all existing shapes.
        while (this.body.shapes.length) {
            this.body.removeShape(this.body.shapes[0]);
        }
        // Rebuild shapes with scaled radius and height.
        const scaledRadius = this.radius * this.scale;
        const scaledHeight = this.height * this.scale;
        this.buildCollisionShapes(scaledRadius, scaledHeight);
        // Update CCD radius.
        this.body.ccdRadius = scaledRadius * 0.8;
        // Update mass: mass scales cubically with scale.
        this.body.mass = 70 * Math.pow(this.scale, 3);
        this.body.updateMassProperties();
    }

    /**
     * Puts the player in held state (by another player using forced perspective) or releases it.
     * When held, the body becomes kinematic and its mass is set to 0.
     * @param {boolean} held - Whether the player is held.
     * @param {Array} pos - The held position [x, y, z] (foot position).
     * @param {Array} rot - The held rotation [x, y, z, w] (quaternion).
     * @param {number} cameraYaw - Yaw of the holding player's camera.
     * @param {number} cameraPitch - Pitch of the holding player's camera.
     * @param {string|null} holderId - ID of the player holding this player.
     * @returns {void}
     */
    setHeld(held, pos, rot, cameraYaw, cameraPitch, holderId = null) {
        this.held = held;
        if (held) {
            // Make kinematic (mass = 0, position controlled by holder).
            this.body.mass = 0;
            this.body.type = CANNON.Body.KINEMATIC;
            this.body.updateMassProperties();
            // Store held transform.
            this.heldPos = pos;
            this.heldRot = rot;
            this.cameraYaw = cameraYaw || 0;
            this.cameraPitch = cameraPitch || 0;
            this.heldBy = holderId;
        } else {
            // Restore dynamic body.
            this.body.mass = 70 * Math.pow(this.scale, 3);
            this.body.type = CANNON.Body.DYNAMIC;
            this.body.updateMassProperties();
            // Clear held data.
            this.heldPos = null;
            this.heldRot = null;
            this.cameraYaw = 0;
            this.cameraPitch = 0;
            this.heldBy = null;
            // Reset input to prevent movement while being released.
            this.input.jump = false;
            this.input.forward = 0;
            this.input.right = 0;
        }
    }

    /**
     * Updates the player's physics (velocity, jump) for a given timestep.
     * This is called by the physics loop for players that are not held (forced perspective or rod).
     * @param {number} dt - Delta time in seconds (fixed timestep).
     * @returns {void}
     */
    updatePhysics(dt) {
        // Skip if held (forced perspective) or rod‑held (spring‑damper drives them).
        if (this.held || this.rodHeld) return;

        // Get movement input.
        const forwardInput = this.input.forward;
        const rightInput = this.input.right;
        // Compute movement direction in world space based on yaw.
        // yaw: rotation around Y; forward is -Z, right is +X.
        const cos = Math.cos(this.yaw);
        const sin = Math.sin(this.yaw);
        // dx = right * cos + forward * (-sin)  (since forward is -Z)
        // dz = -right * sin + forward * (-cos)
        const dx = rightInput * cos + (-forwardInput) * sin;
        const dz = -rightInput * sin + (-forwardInput) * cos;
        const moveDir = new CANNON.Vec3(dx, 0, dz);

        // Get current velocity.
        const vel = this.body.velocity;

        // If there is movement input, set horizontal velocity.
        if (moveDir.length() > 0.01) {
            moveDir.normalize();
            const speedScale = this.scale;
            vel.x = moveDir.x * CONFIG.MOVE_SPEED * speedScale;
            vel.z = moveDir.z * CONFIG.MOVE_SPEED * speedScale;
        } else if (!this.wasDropped) {
            // No input and not in the middle of a throw → stop instantly.
            // This gives responsive stopping.
            vel.x = 0;
            vel.z = 0;
        }
        // If wasDropped is true, we leave horizontal velocity unchanged so the player slides.

        // Jump handling.
        if (this.input.jump && this.onGround && this.canJump) {
            vel.y = CONFIG.JUMP_FORCE * this.scale; // Scale jump force by player scale.
            this.input.jump = false; // Consume the jump input.
            this.canJump = false;    // Prevent double-jump.
            // Temporarily disable collision response to avoid sticking to geometry.
            this.clearContacts();
            this.body.collisionResponse = false;
            this.disableCollisionFrames = 2; // Re‑enable after 2 frames.
            this.jumped = true; // Mark for broadcasting.
        } else if (this.input.jump && !this.onGround) {
            // If jump is pressed but we're not on ground, ignore.
            this.input.jump = false;
        }

        // Store velocity for broadcasting.
        this.velocity = [vel.x, vel.y, vel.z];
    }

    /**
     * Updates the player's ground status using raycasts in a 5x5 grid under the player.
     * This detects if any part of the player's feet is touching the ground.
     * @returns {void}
     */
    updateGroundStatus() {
        // If held (forced perspective or rod), we consider the player airborne.
        if (this.held || this.rodHeld) {
            this.onGround = false;
            return;
        }

        this.wasOnGround = this.onGround;
        this.onGround = false;

        // Perform raycasts in a grid under the player's feet.
        const radius = this.radius * this.scale;
        const halfExtent = radius * 0.8; // Slightly smaller than radius.
        const gridSize = 5;
        const step = (halfExtent * 2) / (gridSize - 1);
        const startX = -halfExtent;
        const startZ = -halfExtent;

        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                const x = startX + i * step;
                const z = startZ + j * step;
                // Ray starts just above the feet (y+0.05) and goes downward.
                const start = new CANNON.Vec3(this.body.position.x + x, this.body.position.y + 0.05, this.body.position.z + z);
                const end = new CANNON.Vec3(this.body.position.x + x, this.body.position.y - 0.5 * this.scale, this.body.position.z + z);
                const result = new CANNON.RaycastResult();
                world.raycastClosest(start, end, {}, result);
                if (result.hasHit && result.body !== this.body) {
                    // If the hit is very close (within 0.25*scale), consider it ground.
                    const hitDistance = start.y - result.hitPointWorld.y;
                    if (hitDistance < 0.25 * this.scale) {
                        this.onGround = true;
                        break;
                    }
                }
            }
            if (this.onGround) break;
        }

        // When landing, allow jumping again.
        if (this.onGround && !this.wasOnGround) {
            this.canJump = true;
        }
    }

    /**
     * Clears contacts that involve this player (used after jump to avoid sticky collisions).
     * @returns {void}
     */
    clearContacts() {
        world.contacts = world.contacts.filter(contact => {
            return contact.bi !== this.body && contact.bj !== this.body;
        });
    }

    /**
     * Called after each physics step to handle temporary collision disable.
     * Also checks whether a thrown player has collided with a static surface
     * and, if so, stops their horizontal momentum.
     * @returns {void}
     */
    postStep() {
        // Skip if held (forced perspective or rod).
        if (this.held || this.rodHeld) return;

        // Decrement collision disable counter and re‑enable collision response when it reaches 0.
        if (this.disableCollisionFrames > 0) {
            this.disableCollisionFrames--;
            if (this.disableCollisionFrames === 0) {
                this.body.collisionResponse = true;
            }
        }

        // If the player was thrown (rod drop) and is now in contact with a static body,
        // immediately zero horizontal velocity and clear the flag.
        if (this.wasDropped) {
            // Check for contacts with static bodies (mass=0).
            const contacts = world.contacts.filter(
                c => (c.bi === this.body || c.bj === this.body) && (c.bi.mass === 0 || c.bj.mass === 0)
            );
            if (contacts.length > 0) {
                // Stop horizontal movement to simulate friction with the ground.
                this.body.velocity.x = 0;
                this.body.velocity.z = 0;
                // Clear the flag so it doesn't keep checking.
                this.wasDropped = false;
            }
        }
    }

    /**
     * Returns a serializable state of the player for broadcasting.
     * @returns {Object} Player state containing id, position, rotation, pitch, onGround,
     *                   isEquipped, inHoldPose, heldObjectId, velocity, heldPos, heldRot,
     *                   held, cameraYaw, cameraPitch, scale, jumped.
     */
    getState() {
        const state = {
            id: this.id,
            // If held, use the held position; otherwise, use the body's position.
            position: this.held ? this.heldPos : [this.body.position.x, this.body.position.y, this.body.position.z],
            rotation: this.yaw,
            pitch: this.pitch,
            onGround: this.onGround,
            isEquipped: this.isEquipped,
            inHoldPose: this.inHoldPose,
            heldObjectId: this.heldObjectId,
            velocity: this.velocity,
            heldPos: this.heldPos,
            heldRot: this.heldRot,
            held: this.held,
            cameraYaw: this.cameraYaw,
            cameraPitch: this.cameraPitch,
            scale: this.scale,
            jumped: this.jumped,
        };
        // Reset jumped flag after broadcasting.
        this.jumped = false;
        return state;
    }
}