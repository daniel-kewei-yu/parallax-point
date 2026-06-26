/*
Author: Daniel Yu
Date: March 15, 2026
Description: Manages the visual representation of blocks on the client. This module receives block state
             updates from the physics worker and creates/updates/removes Three.js meshes accordingly.
             It also maintains a tight yellow wireframe bounding box for each block, which is recomputed
             every frame from the actual world‑space vertices of the mesh's geometry. This ensures the
             bounding box stays precisely aligned with the block's shape, even for spheres and rotated objects.
             The wireframe helper is used for debugging and visual feedback.
*/

// Import Three.js core for geometry, materials, and vector operations.
import * as THREE from 'three';
// Import the global game state (scene, worldObjects map, held object state, etc.)
import { GameState } from '../clientState.js';
// Import PortalPickup to check if a block is currently held by the rod (Q key).
import { PortalPickup } from './portalMechanics/PortalPickup.js';

/**
 * Map from block ID to the yellow wireframe helper (LineSegments) that shows the tight AABB.
 * The helper is a BoxGeometry with edges, scaled and positioned to match the block's world‑space AABB.
 */
export const blockBoxHelpers = new Map();

/**
 * Creates a yellow wireframe box that tightly encloses the mesh's actual world‑space vertices.
 * The box is automatically added to the scene. The helper is initially a unit cube, and its
 * position and scale will be updated later using `updateTightBoxHelper()`.
 * @param {THREE.Mesh} mesh - The block mesh for which to create the helper.
 * @returns {THREE.LineSegments} The wireframe helper, added to the scene.
 */
function createTightBoxHelper(mesh) {
    // Create a unit BoxGeometry (1x1x1) and extract its edges.
    const boxGeom = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(boxGeom);
    // Create a line segments object with yellow colour (0xffff00).
    const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffff00 })
    );
    // Set a high render order so the helper is drawn on top of other geometry.
    line.renderOrder = 999;
    // Add the helper to the scene.
    GameState.scene.add(line);
    return line;
}

/**
 * Recalculates the tight world‑space AABB from the mesh's geometry vertices and updates
 * the helper's position and scale to match. This is called every frame for held blocks
 * and whenever a block's transform changes.
 * @param {THREE.Mesh} mesh - The block mesh.
 * @param {THREE.LineSegments} line - The wireframe helper to update.
 * @returns {void}
 */
function updateTightBoxHelper(mesh, line) {
    // If the mesh has no geometry or no vertex positions, we cannot compute the AABB.
    if (!mesh.geometry || !mesh.geometry.attributes.position) return;

    // Get the position attribute (buffer of vertices in local space).
    const position = mesh.geometry.attributes.position;
    // Get the world transformation matrix of the mesh.
    const worldMat = mesh.matrixWorld;

    // Initialise min and max vectors with extreme values.
    let min = new THREE.Vector3(Infinity, Infinity, Infinity);
    let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // Iterate over all vertices of the geometry.
    for (let i = 0; i < position.count; i++) {
        // Create a vector from the vertex position (local space).
        const vertex = new THREE.Vector3().fromBufferAttribute(position, i);
        // Transform the vertex into world space using the mesh's world matrix.
        vertex.applyMatrix4(worldMat);
        // Update the min and max bounds.
        min.min(vertex);
        max.max(vertex);
    }

    // Compute the centre of the AABB.
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    // Compute the size (width, height, depth) of the AABB.
    const size = new THREE.Vector3().subVectors(max, min);

    // Set the helper's position to the centre and its scale to the size.
    // Since the helper is a unit cube, scaling it by (width, height, depth) makes it exactly fit the AABB.
    line.position.copy(center);
    line.scale.copy(size);
    // Force the world matrix to update so the helper is rendered correctly.
    line.updateMatrixWorld();
}

/**
 * Updates the tight bounding‑box helper for the given block mesh.
 * The helper must already exist in the blockBoxHelpers map.
 * @param {THREE.Mesh} mesh - The block mesh whose helper should be updated.
 * @returns {void}
 */
export function updateBlockHelper(mesh) {
    // Retrieve the helper from the map using the block's ID.
    const helper = blockBoxHelpers.get(mesh.userData.id);
    if (!helper) return; // If no helper exists, do nothing.
    // Recompute the helper's position and scale from the mesh's current vertices.
    updateTightBoxHelper(mesh, helper);
}

/**
 * Updates the scene to match the current block states received from the worker.
 * This function:
 * 1. Removes blocks that no longer exist in the worker's state.
 * 2. Creates new block meshes and helpers for blocks that don't exist yet.
 * 3. Updates transforms and materials of existing blocks.
 * 4. Skips blocks that are currently held by forced perspective (E key) but NOT if held by the rod (Q key).
 * @param {Array} blocksState - Array of block state objects from the worker.
 *                               Each object: { id, type, position, rotation, scale, color, owner, dimensions }.
 * @returns {void}
 */
export function updateBlocks(blocksState) {
    // ----- Step 1: Remove blocks that no longer exist -----
    // Iterate over a snapshot of the worldObjects map to avoid modification issues.
    for (const [id, mesh] of GameState.worldObjects) {
        // Check if this block ID is not present in the new state.
        if (!blocksState.some((b) => b.id === id)) {
            // Remove the mesh from the scene.
            GameState.scene.remove(mesh);
            // Delete the entry from the worldObjects map.
            GameState.worldObjects.delete(id);

            // If a helper exists for this block, remove it from the scene and delete the map entry.
            if (blockBoxHelpers.has(id)) {
                GameState.scene.remove(blockBoxHelpers.get(id));
                blockBoxHelpers.delete(id);
            }
        }
    }

    // ----- Step 2: Update existing or create new blocks -----
    for (const b of blocksState) {
        // Skip updating this block if it is currently held by forced perspective (E key).
        // However, if it is held by the rod (Q key), we still want to update its visual appearance
        // because the rod holds the mesh at a target position, not a kinematic transform.
        if (GameState.heldObjectId === b.id && !PortalPickup.active) {
            continue;
        }

        // Try to retrieve the existing mesh from the worldObjects map.
        let mesh = GameState.worldObjects.get(b.id);
        if (!mesh) {
            // ----- Create a new block mesh -----
            let geometry;
            // Choose the geometry based on the block's type.
            switch (b.type) {
                case 'sphere':
                    geometry = new THREE.SphereGeometry(0.5, 32, 32);
                    break;
                case 'cylinder':
                    geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
                    break;
                case 'triangularPrism':
                    geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 3);
                    break;
                case 'pyramid':
                    geometry = new THREE.ConeGeometry(0.5, 1, 4);
                    break;
                case 'rectangularPrism':
                    // Rectangular prisms have custom dimensions stored in b.dimensions.
                    geometry = b.dimensions
                        ? new THREE.BoxGeometry(b.dimensions.x, b.dimensions.y, b.dimensions.z)
                        : new THREE.BoxGeometry(1, 1, 1);
                    break;
                default: // 'box'
                    geometry = new THREE.BoxGeometry(1, 1, 1);
            }
            // Create a standard material with the block's colour.
            const material = new THREE.MeshStandardMaterial({ color: b.color });
            // Instantiate the mesh.
            mesh = new THREE.Mesh(geometry, material);
            // Enable shadow casting and receiving for realism.
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            // Store the block's ID, owner, type, and dimensions in userData for later reference.
            mesh.userData = { id: b.id, owner: b.owner, type: b.type, dimensions: b.dimensions };
            // Add the mesh to the scene.
            GameState.scene.add(mesh);
            // Store it in the worldObjects map.
            GameState.worldObjects.set(b.id, mesh);

            // Create the tight yellow bounding box helper and add it to the scene.
            const helper = createTightBoxHelper(mesh);
            blockBoxHelpers.set(b.id, helper);
        }

        // ----- Update the mesh's transform and appearance -----
        // Position is an array of [x, y, z].
        mesh.position.fromArray(b.position);
        // Rotation is a quaternion [x, y, z, w].
        mesh.quaternion.fromArray(b.rotation);
        // Scale is a uniform scalar.
        mesh.scale.set(b.scale, b.scale, b.scale);
        // Update the owner in userData (may have changed).
        mesh.userData.owner = b.owner;
        // Update the material colour (if material exists).
        if (mesh.material) mesh.material.color.setHex(b.color);

        // Update the tight bounding box helper to match the new transform.
        if (blockBoxHelpers.has(b.id)) {
            // Retrieve the helper and update it using the mesh's current vertices.
            updateTightBoxHelper(mesh, blockBoxHelpers.get(b.id));
        }
    }
}