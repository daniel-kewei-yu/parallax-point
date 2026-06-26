/*
Author: Daniel Yu
Date: March 15, 2026
Description: Manages animation updates for the local and remote players.
             It runs at a fixed frame rate (approx 60 FPS) and updates the
             FirstPersonCharacter and all remote player animations with the
             time delta since the last update.
*/

// Import the global game state object, holding references to the local player and remote player manager.
import { GameState } from '../clientState.js';
// Import the RemotePlayerManager singleton that handles all remote player avatars and their animations.
import { RemotePlayerManager } from '../players/RemotePlayerManager.js';

// Stores the timestamp (in milliseconds) of the last animation update to compute the elapsed time between frames.
let lastAnimTime = performance.now();

/**
 * Updates animations for the local player (FirstPersonCharacter) and all remote players.
 * It calculates the time delta since the last call, caps it to prevent large jumps, and passes it to the respective update methods.
 * This function is called at a fixed interval (~60 times per second) to keep animations smooth.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
function updateAnimations() {
    // Get the current high-resolution timestamp.
    const now = performance.now();

    // Compute the time difference in seconds since the last update.
    // Cap the delta to a maximum of 0.1 seconds to avoid extreme animation steps if the tab was inactive or the system lagged.
    let delta = Math.min((now - lastAnimTime) / 1000, 0.1);

    // Update the last animation timestamp to the current time for the next frame.
    lastAnimTime = now;

    // If the local player character exists, update its animations (including model, bone poses, and camera smoothing) with the computed delta.
    if (GameState.firstPersonChar) {
        GameState.firstPersonChar.update(delta);
    }

    // Update the animations of all remote players (avatars, bone poses, equipment animations) with the same delta.
    RemotePlayerManager.updateRemoteAnimations(delta);
}

/**
 * Starts the animation loop by scheduling a repeating function call using setInterval.
 * The interval is set to roughly 16.67 ms (1000/60) to target 60 frames per second.
 * This ensures that animations are updated at a consistent rate independently of the rendering frame rate.
 *
 * @param {void} - No parameters.
 * @returns {void} - No return value.
 */
export function startAnimationLoop() {
    // Set up a recurring timer that calls updateAnimations every 16.67 ms (60 Hz).
    setInterval(() => {
        // Execute the animation update function.
        updateAnimations();
    }, 1000 / 60); // The interval in milliseconds: 1000 ms / 60 = 16.67 ms.
}