/*
Author: Daniel Yu
Date: March 15, 2026 (updated June 18, 2026)
Description: Defines the Block class for the physics worker. Each block has a Cannon.js body
             with a shape determined by its type (sphere, cylinder, pyramid, etc.). The class
             handles scaling (rebuilding the shape and updating mass) and provides a serializable
             state for broadcasting. The worker also contains the initial world blocks.
             Fixed: body.userData is now initialised so pickup handlers can safely access
             _originalMaterial.
*/

// Import Cannon.js from CDN.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
// Import the shared world, block material, and blocks map from the main worker module.
import { world, blockMaterial, blocks } from './physicsSharedWorker.js';
// Import the configuration constants (block base mass, etc.).
import { CONFIG } from './worker_config.js';

/**
 * Represents a physics block in the world.
 * Each block has a Cannon.js body with a shape that depends on its type.
 * Blocks can be picked up, held, scaled, and dropped.
 */
export class Block {
    /**
     * Constructs a new physics block.
     * @param {number} x - Initial X position (world space).
     * @param {number} y - Initial Y position (world space).
     * @param {number} z - Initial Z position (world space).
     * @param {string} type - The shape type: 'box', 'sphere', 'cylinder', 'triangularPrism', 'pyramid', or 'rectangularPrism'.
     * @param {number} color - Hex colour code for the block.
     * @param {number} [scale=1] - Uniform scale factor.
     * @param {Object} [dimensions=null] - For rectangularPrism, an object with {x, y, z} dimensions.
     */
    constructor(x, y, z, type, color, scale = 1, dimensions = null) {
        // Generate a random alphanumeric ID for the block.
        this.id = Math.random().toString(36).substring(2, 10);
        // Store block properties.
        this.type = type;
        this.color = color;
        this.scale = scale;
        this.dimensions = dimensions;

        // Build the Cannon.js shape based on type, scale, and dimensions.
        this.buildShape();

        // Create the physics body with mass based on scale (mass scales cubically).
        this.body = new CANNON.Body({ mass: CONFIG.BLOCK_BASE_MASS * Math.pow(scale, 3), material: blockMaterial });
        // Initialise userData with the block ID so we can identify the body later.
        this.body.userData = { blockId: this.id };
        // Add the shape to the body.
        this.body.addShape(this.shape);
        // Set initial position.
        this.body.position.set(x, y, z);
        // Apply some damping to prevent excessive sliding and spinning.
        this.body.linearDamping = 0.1;
        this.body.angularDamping = 0.1;
        // Enable CCD (continuous collision detection) for faster-moving objects.
        this.body.ccdSpeedThreshold = 1;
        this.body.ccdRadius = scale * 0.5;
        // Add the body to the world.
        world.addBody(this.body);

        // Owner of the block (player ID) – null means unowned.
        this.owner = null;
        // Held position, rotation, and scale (used when the block is being held).
        this.heldPos = null;
        this.heldRot = null;
        this.heldScale = null;
    }

    /**
     * Builds or rebuilds the Cannon.js shape based on the current type, scale, and dimensions.
     * This is called in the constructor and during scaling.
     * @returns {void}
     */
    buildShape() {
        const scale = this.scale;
        const type = this.type;
        const dimensions = this.dimensions;

        // Switch on type to create the appropriate shape.
        switch (type) {
            case 'sphere':
                // Sphere with radius 0.5 * scale.
                this.shape = new CANNON.Sphere(0.5 * scale);
                break;
            case 'cylinder':
                // Cylinder with radius 0.5 * scale and height 1 * scale.
                this.shape = new CANNON.Cylinder(0.5 * scale, 0.5 * scale, 1 * scale, 8);
                break;
            case 'triangularPrism':
                // Cylinder with 3 sides (a triangular prism).
                this.shape = new CANNON.Cylinder(0.5 * scale, 0.5 * scale, 1 * scale, 3);
                break;
            case 'pyramid':
                // Cone with top radius 0 (a pyramid) and bottom radius 0.5 * scale, height 1 * scale.
                this.shape = new CANNON.Cylinder(0, 0.5 * scale, 1 * scale, 4);
                break;
            case 'rectangularPrism':
                // Rectangular box with custom dimensions.
                if (!dimensions) dimensions = { x: 1, y: 1, z: 1 };
                const w = dimensions.x * scale;
                const h = dimensions.y * scale;
                const d = dimensions.z * scale;
                // Box shape uses half-extents.
                this.shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
                break;
            default: // 'box'
                // Default cube of size scale.
                this.shape = new CANNON.Box(new CANNON.Vec3(0.5 * scale, 0.5 * scale, 0.5 * scale));
        }
    }

    /**
     * Changes the block's scale, rebuilding the shape and updating mass.
     * @param {number} newScale - The new uniform scale factor.
     * @returns {void}
     */
    setScale(newScale) {
        // If the scale hasn't changed, do nothing.
        if (newScale === this.scale) return;
        // Update the stored scale.
        this.scale = newScale;
        // Remove all existing shapes from the body.
        while (this.body.shapes.length) {
            this.body.removeShape(this.body.shapes[0]);
        }
        // Build the new shape with the updated scale.
        this.buildShape();
        // Add the new shape to the body.
        this.body.addShape(this.shape);
        // Update mass: base mass * scale^3.
        this.body.mass = CONFIG.BLOCK_BASE_MASS * Math.pow(newScale, 3);
        this.body.updateMassProperties();
        // Update CCD radius.
        this.body.ccdRadius = newScale * 0.5;
    }

    /**
     * Returns a serializable state of the block for broadcasting.
     * If the block is held, returns the held position, rotation, and scale;
     * otherwise, returns the body's current transform.
     * @returns {Object} The block state object containing id, type, position, rotation, scale, color, owner, dimensions.
     */
    getState() {
        // If the block is held and has held transform data, use those.
        if (this.owner && this.heldPos && this.heldRot) {
            return {
                id: this.id,
                type: this.type,
                position: this.heldPos,
                rotation: this.heldRot,
                scale: this.heldScale !== null ? this.heldScale : this.scale,
                color: this.color,
                owner: this.owner,
                dimensions: this.dimensions
            };
        }
        // Otherwise, use the physics body's current transform.
        return {
            id: this.id,
            type: this.type,
            position: [this.body.position.x, this.body.position.y, this.body.position.z],
            rotation: [this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w],
            scale: this.scale,
            color: this.color,
            owner: this.owner,
            dimensions: this.dimensions
        };
    }
}

/**
 * Creates the initial set of blocks in the world with various shapes and positions.
 * This is called once when the worker starts.
 * @returns {void}
 */
export function createInitialWorld() {
    // Define an array of block configurations.
    const initialBlocks = [
        // Boxes (default cubes)
        { type: 'box', pos: [3, 0.6, 2], color: 0xff5555, scale: 1.0 },
        { type: 'box', pos: [0, 0.5, 5], color: 0x55ff55, scale: 0.8 },
        { type: 'box', pos: [-3, 0.7, -2], color: 0x5555ff, scale: 1.2 },
        { type: 'box', pos: [4, 0.8, -4], color: 0xffdd55, scale: 1.5 },
        { type: 'box', pos: [-4, 0.4, 3], color: 0xff55ff, scale: 0.6 },
        { type: 'box', pos: [1, 0.6, -2], color: 0x55ddff, scale: 1.0 },
        { type: 'box', pos: [-2, 0.7, -1], color: 0xdd55ff, scale: 1.3 },
        { type: 'box', pos: [5, 0.55, 1], color: 0xffaa55, scale: 0.9 },
        { type: 'box', pos: [2, 0.4, 3], color: 0x88aaff, scale: 0.5 },
        { type: 'box', pos: [-3, 0.4, -1], color: 0x88aaff, scale: 0.5 },
        { type: 'box', pos: [0, 0.4, -4], color: 0x88aaff, scale: 0.5 },

        // Spheres
        { type: 'sphere', pos: [-2, 1.2, 4], color: 0xffaa88, scale: 0.8 },
        { type: 'sphere', pos: [5, 1.5, -3], color: 0x88ffaa, scale: 1.2 },
        { type: 'sphere', pos: [-5, 1.0, 2], color: 0xaa88ff, scale: 0.6 },

        // Cylinders
        { type: 'cylinder', pos: [2, 0.8, -5], color: 0xffaa88, scale: 0.9 },
        { type: 'cylinder', pos: [-4, 0.6, 5], color: 0x88ffaa, scale: 1.1 },
        { type: 'cylinder', pos: [6, 0.9, -2], color: 0xaa88ff, scale: 0.7 },

        // Triangular prisms
        { type: 'triangularPrism', pos: [-1, 0.7, -4], color: 0xffaa88, scale: 1.0 },
        { type: 'triangularPrism', pos: [3, 0.5, -6], color: 0x88ffaa, scale: 0.8 },
        { type: 'triangularPrism', pos: [-5, 0.6, -1], color: 0xaa88ff, scale: 1.2 },

        // Pyramids
        { type: 'pyramid', pos: [4, 0.5, 4], color: 0xffaa88, scale: 0.9 },
        { type: 'pyramid', pos: [-3, 0.6, 6], color: 0x88ffaa, scale: 1.1 },
        { type: 'pyramid', pos: [1, 0.4, -6], color: 0xaa88ff, scale: 0.7 },

        // Rectangular prism (tall thin block)
        { type: 'rectangularPrism', pos: [7, 0.5, 7], color: 0xffaa88, scale: 1.0, dimensions: { x: 0.4, y: 1.8, z: 0.4 } }
    ];

    // Iterate over each configuration, create a Block instance, and add it to the blocks map.
    initialBlocks.forEach(b => {
        const block = new Block(b.pos[0], b.pos[1], b.pos[2], b.type, b.color, b.scale, b.dimensions);
        blocks.set(block.id, block);
    });
}