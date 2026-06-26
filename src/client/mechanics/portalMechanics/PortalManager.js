/*
Author: Daniel Yu
Date: April 24, 2026
Description: Central registry for all portal pairs in the scene. This module receives portal state updates
             from the physics worker, creates/destroys Portal objects, and owns the PortalRenderer responsible
             for the recursive stencil‑based rendering pass through every active portal. Portals are grouped
             by their owner player ID; a pair is only formed when both a blue and an orange portal exist for
             the same owner. Unpaired portals render as solid discs (no teleportation).
*/

// Import Three.js core utilities for vectors, quaternions, and matrix operations.
import * as THREE from 'three';
// Import the Portal class, which defines the visual mesh (disc + ring) and plane.
import { Portal } from './Portal.js';
// Import the PortalRenderer class that handles the recursive stencil rendering of portal views.
import { PortalRenderer } from './PortalRenderer.js';
// Import the singleton manager for visual proxies (clones) of objects intersecting portals.
import { PortalProxyManager } from './PortalProxyManager.js';
// Import the singleton manager for portal interactions (proxy creation and camera detachment).
import { PortalInteraction } from './PortalInteraction.js';

/**
 * Singleton object that manages all portals in the scene.
 * It maintains maps of all portals and portal pairs, and owns the renderer.
 */
export const PortalManager = {
    /**
     * Map from owner player ID to an object containing the blue and orange portals for that player.
     * Only present when both portals exist; otherwise the portals remain in allPortals but unpaired.
     * @type {Map<string, {blue: Portal|null, orange: Portal|null}>}
     */
    portalPairs: new Map(),

    /**
     * Map from portal ID to the Portal instance. Contains all portals, whether paired or not.
     * @type {Map<string, Portal>}
     */
    allPortals: new Map(),

    /**
     * The PortalRenderer instance that performs the recursive stencil rendering.
     * @type {PortalRenderer|null}
     */
    renderer: null,

    /**
     * Flag indicating whether the manager has been initialised with scene and renderer references.
     * @type {boolean}
     */
    initialized: false,

    /**
     * Reference to the Three.js scene containing all objects (used for adding/removing portals).
     * @type {THREE.Scene|null}
     */
    scene: null,

    /**
     * Reference to the Three.js WebGLRenderer (used by the PortalRenderer).
     * @type {THREE.WebGLRenderer|null}
     */
    webglRenderer: null,

    /**
     * Initialises the portal manager with the scene and renderer references.
     * Must be called once after the main renderer is created.
     * @param {THREE.Scene} scene - The main scene to add portal meshes to.
     * @param {THREE.WebGLRenderer} webglRenderer - The renderer used for drawing (requires stencil buffer).
     * @returns {void}
     */
    init(scene, webglRenderer) {
        // Store references for later use (e.g., adding/removing meshes, rendering).
        this.scene = scene;
        this.webglRenderer = webglRenderer;

        // Create the PortalRenderer instance, passing the scene and renderer.
        this.renderer = new PortalRenderer(scene, webglRenderer);

        // Initialise the proxy manager so it can add/remove clone meshes to the scene.
        PortalProxyManager.init(scene);

        // Initialise the interaction manager (for camera detachment and proxy logic).
        PortalInteraction.init();

        // Mark as initialised so other methods can check this flag.
        this.initialized = true;
    },

    /**
     * Synchronises the portal state with data received from the physics worker.
     * Creates new portals, removes old ones, and updates transforms of existing portals.
     * After updating, it rebuilds the portalPairs map to reflect any ownership changes.
     * @param {Array} portals - Array of portal state objects (each containing id, type, position, rotation, owner).
     * @returns {void}
     */
    updatePortals(portals) {
        // Skip if the manager hasn't been initialised (prevents errors before setup).
        if (!this.initialized) return;

        // Build a Set of all portal IDs received from the worker for quick lookup.
        const currentIds = new Set(portals.map(p => p.id));

        // ----- Remove portals that no longer exist in the worker's state -----
        // Iterate over a copy of allPortals entries to avoid mutation issues.
        for (const [id, portal] of this.allPortals) {
            // If this portal ID is not in the current set, it has been removed.
            if (!currentIds.has(id)) {
                // Remove the portal's mesh from the scene.
                this.scene.remove(portal.mesh);
                // Delete the portal from the allPortals map.
                this.allPortals.delete(id);

                // Clean up the portalPairs map: if this portal was part of a pair, nullify its entry.
                for (const [playerId, pair] of this.portalPairs) {
                    if (pair.blue && pair.blue.id === id) pair.blue = null;
                    if (pair.orange && pair.orange.id === id) pair.orange = null;
                    // If both slots are now null, remove the entire pair entry.
                    if (!pair.blue && !pair.orange) this.portalPairs.delete(playerId);
                }

                // Inform the proxy manager to cancel any active proxies associated with this portal.
                PortalProxyManager.cancelProxiesForPortal(id);
            }
        }

        // ----- Create or update existing portals -----
        for (const portalState of portals) {
            // Try to retrieve an existing portal by ID.
            let portal = this.allPortals.get(portalState.id);
            if (!portal) {
                // ----- Create a new portal -----
                // Extract position and rotation from the state (arrays).
                const position = new THREE.Vector3(
                    portalState.position[0],
                    portalState.position[1],
                    portalState.position[2]
                );
                const rotation = new THREE.Quaternion(
                    portalState.rotation[0],
                    portalState.rotation[1],
                    portalState.rotation[2],
                    portalState.rotation[3]
                );
                // Instantiate a new Portal object (creates disc and ring meshes).
                portal = new Portal(portalState.id, portalState.type, position, rotation);

                // Store the owner ID on the mesh's userData so rebuildPairs can group portals by owner.
                // If no owner is provided, default to 'unknown' to avoid grouping errors.
                portal.mesh.userData.portalOwner = portalState.owner || 'unknown';

                // Add the portal's mesh group to the scene.
                this.scene.add(portal.mesh);
                // Store the portal in the allPortals map.
                this.allPortals.set(portalState.id, portal);
            } else {
                // ----- Update an existing portal's transform -----
                const position = new THREE.Vector3(
                    portalState.position[0],
                    portalState.position[1],
                    portalState.position[2]
                );
                const rotation = new THREE.Quaternion(
                    portalState.rotation[0],
                    portalState.rotation[1],
                    portalState.rotation[2],
                    portalState.rotation[3]
                );
                // Update the portal's position, rotation, forward, and plane.
                portal.updateTransform(position, rotation);
                // Optionally update the owner if it changed (though unlikely).
                portal.mesh.userData.portalOwner = portalState.owner || 'unknown';
            }
        }

        // Rebuild the portalPairs map based on the current owner data.
        // This must be done after all additions/removals/updates.
        this.rebuildPairs();
    },

    /**
     * Rebuilds the portalPairs map from allPortals, grouping portals by their owner ID.
     * A pair is created only when both a blue and an orange portal exist for the same owner.
     * Unpaired portals remain in allPortals but are not part of any pair, so they render as solid discs.
     * @returns {void}
     */
    rebuildPairs() {
        // Clear the existing pairs map.
        this.portalPairs.clear();

        // Temporary map: owner -> { blue: Portal|null, orange: Portal|null }
        const byOwner = new Map();

        // Iterate over all portals currently in the scene.
        for (const portal of this.allPortals.values()) {
            // Retrieve the owner from the mesh's userData (set during creation/update).
            const owner = portal.mesh.userData.portalOwner || 'unknown';
            // If this owner is not yet in the map, create an entry with null slots.
            if (!byOwner.has(owner)) {
                byOwner.set(owner, { blue: null, orange: null });
            }
            // Get the entry for this owner.
            const entry = byOwner.get(owner);
            // Assign the portal to the appropriate colour slot.
            if (portal.type === 'blue') {
                entry.blue = portal;
            } else if (portal.type === 'orange') {
                entry.orange = portal;
            }
        }

        // After collecting all portals by owner, add pairs only when both colours are present.
        for (const [owner, entry] of byOwner) {
            if (entry.blue && entry.orange) {
                // Both portals exist: create a pair entry in portalPairs.
                this.portalPairs.set(owner, { blue: entry.blue, orange: entry.orange });
            }
            // If only one colour exists, the portal remains unpaired and will be rendered as a solid disc.
        }
    },

    /**
     * Returns the portal that is paired with the given portal.
     * Searches through all portal pairs and returns the counterpart if found.
     * @param {Portal} portal - The portal whose pair is requested.
     * @returns {Portal|null} The paired portal, or null if the portal is not part of any pair.
     */
    getPair(portal) {
        // Iterate over all pairs in the portalPairs map.
        for (const [, pair] of this.portalPairs) {
            // If the given portal is the blue one, return the orange one.
            if (pair.blue === portal) return pair.orange;
            // If the given portal is the orange one, return the blue one.
            if (pair.orange === portal) return pair.blue;
        }
        // No pair found: return null.
        return null;
    },

    /**
     * Runs the recursive portal rendering pass for all active portal pairs.
     * This method is called every frame from the render loop and triggers the stencil-based rendering.
     * @param {THREE.PerspectiveCamera} viewerCamera - The main camera (may be detached during portal traversal).
     * @returns {void}
     */
    render(viewerCamera) {
        // Skip if the manager is not initialised or the renderer is null.
        if (!this.initialized || !this.renderer) return;
        // Delegate the rendering to the PortalRenderer, passing the camera and all portal pairs.
        this.renderer.renderAll(viewerCamera, this.portalPairs);
    },

    /**
     * Removes all portal meshes from the scene and clears internal state.
     * Also resets the proxy manager and disposes of the renderer.
     * This is used when the player disconnects or the world is reset.
     * @returns {void}
     */
    clear() {
        // Remove every portal mesh from the scene.
        for (const portal of this.allPortals.values()) {
            this.scene.remove(portal.mesh);
        }
        // Clear the maps.
        this.allPortals.clear();
        this.portalPairs.clear();
        // Clear any active proxies.
        PortalProxyManager.clear();
        // Dispose of the renderer to free GPU resources (if any).
        if (this.renderer) this.renderer.dispose();
    },
};