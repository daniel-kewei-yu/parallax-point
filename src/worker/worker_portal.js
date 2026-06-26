/*
Author: Daniel Yu
Date: March 15, 2026
Description: Portal data structures and physics ring colliders for the worker. This module manages
             portal state per player, stores portals in a Map (blue/orange per player), and creates
             physics bodies (ring colliders) that block physical passage through the portal border.
             Each portal carries an ownerId so the client can group portals per player, preventing
             cross‑player pairing. The ring colliders are composed of many small spheres arranged
             in an ellipse to approximate a physical ring that objects cannot pass through.
*/

// Import Cannon.js for physics bodies, shapes, and vector/math utilities.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
// Import the shared world and block material from the main worker module.
import { world, blockMaterial } from './physicsSharedWorker.js';

// ----- Global portal state -----
/**
 * Map from playerId to an object containing the player's blue and orange portals.
 * Example: playerPortals.get('p_5') = { blue: Portal, orange: Portal }
 * @type {Map<string, {blue: Portal|null, orange: Portal|null}>}
 */
export const playerPortals = new Map();
// Simple counter for generating unique portal IDs.
let nextPortalId = 1;

/**
 * Represents a portal in the physics world.
 * Each portal has a unique ID, type (blue/orange), position, rotation, and a ring body
 * that blocks physical passage through the portal border.
 */
export class Portal {
    /**
     * Constructs a new portal.
     * @param {string} id - Unique portal ID.
     * @param {string} type - 'blue' or 'orange'.
     * @param {CANNON.Vec3} position - World-space position of the portal centre.
     * @param {CANNON.Quaternion} rotation - Orientation of the portal (local Z points outward).
     */
    constructor(id, type, position, rotation) {
        // Unique identifier for this portal.
        this.id = id;
        // Portal type: 'blue' or 'orange'.
        this.type = type;
        // World-space position.
        this.position = position;
        // Orientation quaternion (local Z is the forward direction).
        this.rotation = rotation;
        // Whether the portal is active (always true initially).
        this.active = true;
        // The compound body that forms the ring collider (blocks physical passage).
        this.ringBody = null;
        // ID of the player who placed this portal (for client-side grouping).
        this.ownerId = null;
    }

    /**
     * Returns a serialisable representation of the portal for broadcasting.
     * @returns {Object} Portal state object containing id, type, owner, position, rotation, and active.
     */
    getState() {
        return {
            id: this.id,
            type: this.type,
            owner: this.ownerId,                      // included for client grouping.
            position: [this.position.x, this.position.y, this.position.z],
            rotation: [this.rotation.x, this.rotation.y, this.rotation.z, this.rotation.w],
            active: this.active
        };
    }
}

/**
 * Generates a unique portal ID with a 'portal_' prefix.
 * @returns {string} A new unique portal ID.
 */
export function generatePortalId() {
    return 'portal_' + (nextPortalId++);
}

// ----------------------------------------------------------------------
//  Ring collider – single compound body
// ----------------------------------------------------------------------

/**
 * Creates a ring of small spheres around the portal to block physical passage through the border.
 * The ring is composed of many small spheres arranged in an ellipse around the portal disc.
 * The spheres are small enough to be invisible but create a physical barrier.
 * @param {Portal} portal - The portal to create the ring collider for.
 * @returns {void}
 */
function createRingColliders(portal) {
    // Compute the average radius of the ring (between disc and ring radius).
    const ringRadius = (1.25 + 1.3) / 2;   // 1.275
    // Apply the disc scale (0.8 on X, 1.2 on Y) to make the ring elliptical.
    const rx = ringRadius * 0.8;            // horizontal radius after disc scale.
    const ry = ringRadius * 1.2;            // vertical radius after disc scale.

    // Number of spheres around the ellipse (more = smoother but more expensive).
    const numSpheres = 256;
    // Small enough to block without being visible or causing performance issues.
    const sphereRadius = 0.015;

    // Create a compound body (mass = 0 so it's static).
    const compoundBody = new CANNON.Body({
        mass: 0,                           // Static body (doesn't move).
        material: blockMaterial,           // Use block material for friction.
        collisionResponse: true,           // Objects should collide with the ring.
    });

    // Position the compound body at the portal's position.
    compoundBody.position.copy(portal.position);

    // Iterate around the ellipse and add spheres.
    for (let i = 0; i < numSpheres; i++) {
        // Compute angle around the ellipse.
        const angle = (i / numSpheres) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        // Local coordinates on the ellipse (in portal local space).
        const localX = rx * cos;
        const localY = ry * sin;

        // Offset from the portal centre in portal‑local space (Z = 0, on the plane).
        const offset = new CANNON.Vec3(localX, localY, 0);
        // Transform the offset to world space using the portal's rotation.
        portal.rotation.vmult(offset, offset);

        // Create a small sphere shape and add it to the compound body at the offset.
        const sphereShape = new CANNON.Sphere(sphereRadius);
        compoundBody.addShape(sphereShape, offset);
    }

    // Update mass properties (mass is 0, so this is a no-op, but keeps things consistent).
    compoundBody.updateMassProperties();
    // Add the compound body to the world.
    world.addBody(compoundBody);
    // Store a reference to the ring body in the portal.
    portal.ringBody = compoundBody;
}

/**
 * Removes the ring collider from the physics world for a portal.
 * @param {Portal} portal - The portal whose ring collider should be removed.
 * @returns {void}
 */
function removeRingColliders(portal) {
    if (portal.ringBody) {
        world.removeBody(portal.ringBody);
        portal.ringBody = null;
    }
}

// ----------------------------------------------------------------------
//  Portal management
// ----------------------------------------------------------------------

/**
 * Places (or replaces) a portal of the given type for a specific player.
 * If a portal of that type already exists for the player, it is replaced.
 * @param {string} playerId - The player who owns the portal.
 * @param {string} type - 'blue' or 'orange'.
 * @param {CANNON.Vec3} position - World position of the portal centre.
 * @param {CANNON.Quaternion} rotation - Orientation (local Z points outward from the surface).
 * @returns {Portal} The newly created portal.
 */
export function placePortal(playerId, type, position, rotation) {
    // Retrieve or create the player's portal entry.
    let portals = playerPortals.get(playerId);
    if (!portals) {
        portals = { blue: null, orange: null };
        playerPortals.set(playerId, portals);
    }

    // If there is already a portal of this type, remove its ring colliders.
    const existing = portals[type];
    if (existing) {
        removeRingColliders(existing);
    }

    // Generate a unique ID for the new portal.
    const id = generatePortalId();
    // Create the portal instance.
    const portal = new Portal(id, type, position, rotation);
    // Set the owner ID so the client can group portals by player.
    portal.ownerId = playerId;
    // Store the portal in the appropriate slot.
    portals[type] = portal;

    // Create the ring collider to block physical passage.
    createRingColliders(portal);

    return portal;
}

/**
 * Removes a portal by ID. If the portal belongs to a player, the player's
 * portal entry is updated (or removed if both portals are gone).
 * @param {string} id - The ID of the portal to remove.
 * @returns {void}
 */
export function removePortal(id) {
    // Iterate over all players' portals.
    for (const [playerId, portals] of playerPortals) {
        // Check if this portal is the blue one.
        if (portals.blue && portals.blue.id === id) {
            removeRingColliders(portals.blue);
            portals.blue = null;
            // If both portals are now null, remove the player's entry.
            if (!portals.blue && !portals.orange) playerPortals.delete(playerId);
            return;
        }
        // Check if this portal is the orange one.
        if (portals.orange && portals.orange.id === id) {
            removeRingColliders(portals.orange);
            portals.orange = null;
            // If both portals are now null, remove the player's entry.
            if (!portals.blue && !portals.orange) playerPortals.delete(playerId);
            return;
        }
    }
}

/**
 * Clears all portals belonging to a specific player.
 * @param {string} playerId - The player whose portals should be cleared.
 * @returns {void}
 */
export function clearPlayerPortals(playerId) {
    const portals = playerPortals.get(playerId);
    if (portals) {
        // Remove ring colliders for both portals.
        if (portals.blue) removeRingColliders(portals.blue);
        if (portals.orange) removeRingColliders(portals.orange);
    }
    // Delete the player's portal entry.
    playerPortals.delete(playerId);
}

/**
 * Returns an array of portal state objects for all players.
 * Used for broadcasting the full world state to clients.
 * @returns {Array} Array of portal state objects.
 */
export function getAllPortals() {
    const all = [];
    // Iterate over all players' portals.
    for (const [playerId, portals] of playerPortals) {
        // If a blue portal exists, add its state.
        if (portals.blue) all.push(portals.blue.getState());
        // If an orange portal exists, add its state.
        if (portals.orange) all.push(portals.orange.getState());
    }
    return all;
}