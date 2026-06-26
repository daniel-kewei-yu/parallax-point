/*
Author: Daniel Yu
Date: March 15, 2026
Description: Broadcasts the full world state (blocks, players, portals) to all connected clients.
             This module is called after every physics step to keep all clients synchronised
             with the authoritative server state. The serialised state includes all block properties
             (position, rotation, scale, colour, owner), player properties (position, rotation,
             pitch, scale, held state, equip state), and portal properties (position, rotation,
             type, owner). The message is sent to every connected MessagePort.
*/

// Import the ports map (MessagePort -> playerId) to send messages to all connected clients.
import { ports, players, blocks } from './physicsSharedWorker.js';
// Import the function to get all portal states for broadcasting.
import { getAllPortals } from './worker_portal.js';

/**
 * Broadcasts the current state of all blocks, players, and portals to every connected client.
 * This function serialises the state of every object in the world and sends it as a single
 * 'world_state' message to all active client ports.
 * @param {void} - No parameters.
 * @returns {void}
 */
export function broadcastFullState() {
    // Serialise all blocks by calling getState() on each Block instance.
    const blocksState = Array.from(blocks.values(), b => b.getState());
    // Serialise all players by calling getState() on each Player instance.
    const playersState = Array.from(players.values(), p => p.getState());
    // Serialise all portals by calling getAllPortals() which returns an array of portal state objects.
    const portalsState = getAllPortals();
    // Build the complete world state message.
    const message = { type: 'world_state', blocks: blocksState, players: playersState, portals: portalsState };
    // Iterate over all connected client ports.
    for (const [port, playerId] of ports) {
        try {
            // Attempt to send the state message to this client.
            port.postMessage(message);
        } catch (e) {
            // If sending fails (e.g., port is closed), log a warning and continue.
            console.warn('Failed to send to port', e);
        }
    }
}