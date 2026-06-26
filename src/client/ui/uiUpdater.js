/*
Author: Daniel Yu
Date: March 15, 2026
Description: Updates the player count display in the top‑right corner of the UI.
             It runs every 500ms and updates the text to reflect the number of
             players currently online (remote players + the local player).
*/

import { GameState } from '../clientState.js';

/**
 * Starts a periodic update of the player count display.
 */
export function startPlayerCountUpdater() {
    setInterval(() => {
        if (GameState.playerId) {
            const total = GameState.remotePlayers.size + 1; // remote + local
            const countElement = document.getElementById('player-count');
            if (total === 1) {
                countElement.textContent = `${total} poopy online`;
            } else {
                countElement.textContent = `${total} poopies online`;
            }
        }
    }, 500);
}