/*
Author: Daniel Yu
Date: March 15, 2026
Description: Sets up the Three.js scene, renderer, and lighting. This module creates the main scene,
             configures the WebGL renderer with stencil buffer support for portals, adds ambient,
             directional, and fill lights, and handles window resize events. It also enables shadow
             mapping and local clipping. The scene background is a dark blue colour, and fog is
             added for depth perception. The renderer is appended to the document body.
*/

// Import Three.js core classes for scene, renderer, lights, and camera.
import * as THREE from 'three';
// Import the global game state to store the camera reference and access configuration.
import { GameState } from '../clientState.js';

/**
 * Creates and configures the Three.js rendering infrastructure.
 * This includes the scene, renderer with stencil buffer and shadow support,
 * and a lighting setup. It also adds a window resize listener to update
 * the camera aspect ratio and renderer size.
 * @returns {Object} An object containing the scene and renderer.
 */
export function setupRendering() {
    // ----- Create the scene -----
    // Instantiate a new Three.js scene, which will hold all 3D objects.
    const scene = new THREE.Scene();

    // Set the scene background to a dark blue colour (0x111122) for a space-like atmosphere.
    // This provides a neutral backdrop that makes objects and portals stand out.
    scene.background = new THREE.Color(0x111122);

    // ----- Create the WebGL renderer -----
    // Instantiate the renderer with antialiasing and enable the stencil buffer.
    // The stencil buffer is required for portal rendering (recursive stencil masking).
    const renderer = new THREE.WebGLRenderer({
        antialias: true,   // Smooth edges for better visual quality.
        stencil: true,     // Enable stencil buffer for portal rendering.
    });

    // Set the renderer size to match the current window dimensions.
    renderer.setSize(window.innerWidth, window.innerHeight);

    // Enable shadow mapping to allow objects to cast and receive shadows.
    renderer.shadowMap.enabled = true;
    // Use PCF (Percentage Closer Filtering) soft shadows for smoother shadow edges.
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Enable local clipping per material, which is required for portal proxy clipping.
    renderer.localClippingEnabled = true;

    // Append the renderer's canvas (the 3D viewport) to the HTML document body.
    document.body.appendChild(renderer.domElement);

    // ----- Lighting setup -----

    // Ambient light: provides a soft fill light that illuminates all surfaces evenly.
    // The colour is a muted blue-purple (0x404060) with intensity 1.0.
    const ambientLight = new THREE.AmbientLight(0x404060, 1);
    scene.add(ambientLight);

    // Directional light: simulates a sun-like light source with a warm colour (0xffeedd).
    // It casts shadows and provides the main directional illumination.
    const dirLight = new THREE.DirectionalLight(0xffeedd, 1);
    // Position the light above and to the side to create realistic shading.
    dirLight.position.set(5, 10, 7);

    // Enable shadow casting and receiving for this light.
    dirLight.castShadow = true;
    dirLight.receiveShadow = true;

    // Configure the shadow map resolution for higher quality shadows.
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;

    // Define the shadow camera bounds (an orthographic frustum) to cover the play area.
    const d = 15;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 25;

    // Add the directional light to the scene.
    scene.add(dirLight);

    // Fill light: a point light from the opposite side to reduce harsh shadows.
    // The colour is a cool blue (0x4466ff) with intensity 1.0.
    const fillLight = new THREE.PointLight(0x4466ff, 1);
    fillLight.position.set(-3, 5, 5);
    scene.add(fillLight);

    // ----- Window resize handler -----
    // When the window is resized, update the active camera's aspect ratio
    // and the renderer's size to match the new viewport dimensions.
    window.addEventListener('resize', () => {
        // If a camera exists (set in GameState), update its aspect ratio.
        if (GameState.camera) {
            GameState.camera.aspect = window.innerWidth / window.innerHeight;
            // Recompute the camera's projection matrix to apply the new aspect ratio.
            GameState.camera.updateProjectionMatrix();
        }
        // Resize the renderer to the new window dimensions.
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Return the scene and renderer so they can be stored in the global state.
    return { scene, renderer };
}