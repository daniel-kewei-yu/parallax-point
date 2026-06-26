/*
Author: Daniel Yu
Date: March 15, 2026
Description: Legacy wrapper module that delegates all portal management to the PortalManager singleton.
             This file is kept solely for backward compatibility with existing imports that reference it.
             It provides a `PortalSystem` object with `updatePortals()` and `clear()` methods, which
             internally forward the calls to PortalManager. New code should import PortalManager directly.
             The `portalMeshes` map is no longer used but is retained for compatibility.
*/

// Import the PortalManager singleton, which handles all portal creation, updating, and rendering.
import { PortalManager } from './portalMechanics/PortalManager.js';
// Import the global game state to access the scene and renderer references.
import { GameState } from '../clientState.js';

/**
 * The PortalSystem object exposed for backward compatibility.
 * It delegates to PortalManager for all operations.
 * @property {Map} portalMeshes - Unused map, kept for compatibility (no longer stores meshes).
 */
export const PortalSystem = {
    // Kept for compatibility; this map is never used but may be accessed by legacy code.
    portalMeshes: new Map(),

    /**
     * Updates the portal meshes based on the current portal state received from the worker.
     * This method first ensures the PortalManager is initialised (if not already done),
     * then forwards the update to PortalManager.
     * @param {Array} portals - Array of portal state objects (each containing id, type, position, rotation, owner).
     * @returns {void}
     */
    updatePortals(portals) {
        // Check if PortalManager has not been initialised yet.
        if (!PortalManager.initialized && GameState.scene && GameState.renderer) {
            // If the scene and renderer are available, initialise PortalManager with them.
            PortalManager.init(GameState.scene, GameState.renderer);
        }
        // Forward the portal state update to PortalManager.
        PortalManager.updatePortals(portals);
    },

    /**
     * Removes all portal meshes from the scene and clears all internal portal state.
     * Delegates the call to PortalManager.clear().
     * @returns {void}
     */
    clear() {
        // Forward the clear operation to PortalManager.
        PortalManager.clear();
    }
};