/*
Author: Daniel Yu
Date: June 5, 2026
Description: Implements recursive stencil‑based rendering of portal views. This renderer is responsible for
             drawing the scene through portals using a depth‑stencil approach. For each active portal pair,
             it stamps the portal disc into the stencil buffer, then renders the scene from a virtual camera
             positioned at the exit portal using an oblique projection matrix. It supports up to MAX_RECURSION
             levels (default 2). The outer level uses depth‑tested stamps with polygon offset to handle wall
             occlusion, while inner levels clear depth before the stamp to ensure the mask is always created.
             The renderer also handles hiding of physics capsules and proxy objects during portal views.
*/

import * as THREE from 'three';
import { computeObliqueProjectionMatrix } from './ObliqueNearPlane.js';

// Maximum recursion depth for portal rendering (prevents infinite loops).
const MAX_RECURSION = 2;

/**
 * The PortalRenderer class manages the entire portal rendering pipeline.
 */
export class PortalRenderer {
    /**
     * Constructs the renderer with references to the main scene and WebGL renderer.
     * @param {THREE.Scene} scene - The main scene containing all objects.
     * @param {THREE.WebGLRenderer} renderer - The WebGL renderer (must have stencil buffer enabled).
     */
    constructor(scene, renderer) {
        // Store references for later use.
        this.scene = scene;
        this.renderer = renderer;
        // Get the WebGL context for direct state manipulation.
        this.gl = renderer.getContext();

        // Temporary scene used for rendering individual objects (like portal stamps).
        this.tmpScene = new THREE.Scene();
        // Pre‑compute a rotation matrix for 180° around Y (mirroring across portals).
        this.rotationYMatrix = new THREE.Matrix4().makeRotationY(Math.PI);

        // Store the scene background colour for filling portal discs.
        this.bgColor = scene.background instanceof THREE.Color
            ? scene.background
            : new THREE.Color(0x111122);

        // Create a full‑screen quad mesh for clearing depth within the stencil mask.
        const geo = new THREE.PlaneGeometry(2, 2);
        // Shader material that only writes to depth, not colour.
        this.clearDepthMaterial = new THREE.ShaderMaterial({
            depthWrite: true,      // Write depth values.
            depthTest: false,      // No depth test – always draw.
            vertexShader: `void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }`,
            fragmentShader: `void main() { gl_FragColor = vec4(0.0); }`,
        });
        // The mesh used for depth clearing.
        this.clearDepthQuad = new THREE.Mesh(geo, this.clearDepthMaterial);

        // Array to temporarily store objects that should be hidden during portal rendering.
        this._hiddenObjects = [];
    }

    /**
     * Collects objects that should be hidden during portal rendering (physics capsules, proxies, etc.).
     * These objects would otherwise appear in the portal view incorrectly.
     * @returns {void}
     */
    _collectHiddenObjects() {
        // Reset the array.
        this._hiddenObjects.length = 0;
        // Traverse the entire scene.
        this.scene.traverse(obj => {
            if (!obj.userData) return;
            // Skip local player parts (they should remain visible).
            if (obj.userData.isLocalPlayerPart) return;
            // Hide physics capsules, remote avatar capsules, and proxy clones.
            if (obj.userData.isPhysicsCapsule ||
                obj.userData.remoteAvatarCapsule ||
                obj.userData.isPortalProxyClone) {
                this._hiddenObjects.push(obj);
            }
        });
    }

    /** Hides all collected objects. */
    _hide() { this._hiddenObjects.forEach(o => o.visible = false); }

    /** Restores visibility of all collected objects. */
    _show() { this._hiddenObjects.forEach(o => o.visible = true); }

    /**
     * Extends the far plane of an oblique projection matrix to avoid clipping distant geometry.
     * This is done by adjusting the third row of the matrix.
     * @param {THREE.Matrix4} obliqueMatrix - The oblique projection matrix to modify.
     * @returns {void}
     */
    extendFarPlane(obliqueMatrix) {
        const e = obliqueMatrix.elements;
        // Extract the third row coefficients (m13, m23, m33, m43).
        const cx = e[2], cy = e[6], cz = e[10], cw = e[14];
        // Constants to blend the original third row with the far plane.
        const alpha = 0.5, beta = -0.5;
        // Replace the third row to push the far plane farther.
        e[2]  = alpha * cx;
        e[6]  = alpha * cy;
        e[10] = alpha * cz + beta * (-1);
        e[14] = alpha * cw;
    }

    /**
     * Determines which side of the portal should be rendered based on camera position.
     * If the camera is in front of the portal, render the front side; otherwise, render the back side.
     * @param {Portal} portal - The portal being rendered.
     * @param {THREE.Vector3} cameraPos - World‑space position of the camera.
     * @returns {number} THREE.FrontSide or THREE.BackSide.
     */
    _visibleSide(portal, cameraPos) {
        return portal.signedDistance(cameraPos) >= 0 ? THREE.FrontSide : THREE.BackSide;
    }

    // ------------------------------------------------------------------
    //  PUBLIC entry point
    // ------------------------------------------------------------------

    /**
     * Renders all portal views for the given portal pairs. This is the main method called every frame.
     * @param {THREE.PerspectiveCamera} viewerCamera - The main camera (may be detached).
     * @param {Map} portalPairs - Map of owner -> { blue, orange }.
     * @returns {void}
     */
    renderAll(viewerCamera, portalPairs) {
        // If there are no portal pairs, skip rendering.
        if (portalPairs.size === 0) return;

        const gl = this.gl;

        // Save the renderer's auto‑clear settings.
        const prevAutoClear = this.renderer.autoClear;
        const prevAutoClearColor = this.renderer.autoClearColor;
        const prevAutoClearDepth = this.renderer.autoClearDepth;
        const prevAutoClearStencil = this.renderer.autoClearStencil;
        // Disable auto‑clear; we will manage clearing manually.
        this.renderer.autoClear = false;
        this.renderer.autoClearColor = false;
        this.renderer.autoClearDepth = false;
        this.renderer.autoClearStencil = false;

        // Clear the stencil buffer initially.
        gl.clearStencil(0);
        gl.clear(gl.STENCIL_BUFFER_BIT);

        // Update the viewer camera's matrices.
        viewerCamera.updateMatrixWorld(true);
        // Save the original view and projection matrices.
        const origView = viewerCamera.matrixWorld.clone();
        const origProj = viewerCamera.projectionMatrix.clone();

        // Collect objects that should be hidden during portal rendering.
        this._collectHiddenObjects();

        // Build a flat list of all portals from the pairs.
        const allPortals = [];
        for (const [, pair] of portalPairs) {
            if (pair.blue) allPortals.push(pair.blue);
            if (pair.orange) allPortals.push(pair.orange);
        }

        // Start the recursive portal rendering.
        this._renderPortalsRecursive(viewerCamera, allPortals, origView.clone(), origProj.clone(), 0);

        // ----- FINAL PASS: draw the actual portal meshes (discs + rings) -----
        // Disable stencil test and restore colour/depth writing.
        gl.disable(gl.STENCIL_TEST);
        gl.stencilMask(0x00);
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);

        // Hide all portal discs so they don't overwrite the filled background.
        const discVisStates = allPortals.map(p => p.discMesh.visible);
        allPortals.forEach(p => { p.discMesh.visible = false; });

        // Ensure all portal groups are visible (rings will be visible, discs hidden).
        for (const portal of allPortals) {
            portal.mesh.visible = true;
        }
        // Show the objects that were hidden (capsules, proxies).
        this._show();

        // Render the final scene with the original camera.
        this._renderSceneRaw(this.scene, viewerCamera, origView, origProj);

        // Restore disc visibility.
        allPortals.forEach((p, i) => { p.discMesh.visible = discVisStates[i]; });

        // Restore the camera matrices.
        viewerCamera.matrixWorld.copy(origView);
        viewerCamera.matrixWorldInverse.copy(origView).invert();
        viewerCamera.projectionMatrix.copy(origProj);

        // Restore auto‑clear settings.
        this.renderer.autoClear = prevAutoClear;
        this.renderer.autoClearColor = prevAutoClearColor;
        this.renderer.autoClearDepth = prevAutoClearDepth;
        this.renderer.autoClearStencil = prevAutoClearStencil;
    }

    // ------------------------------------------------------------------
    //  Core recursive function (bidirectional, no infinite loop)
    // ------------------------------------------------------------------

    /**
     * Recursively renders portal views. For each portal, it stamps the disc, fills with background,
     * renders the scene from the virtual camera, and recurses into the paired portal.
     * @param {THREE.PerspectiveCamera} viewerCamera - The main camera.
     * @param {Portal[]} allPortals - Flat array of all portals.
     * @param {THREE.Matrix4} viewMat - Current view matrix.
     * @param {THREE.Matrix4} projMat - Current projection matrix.
     * @param {number} recursionLevel - Current recursion depth (0 = outer).
     * @param {Portal|null} skipPortal - The portal to skip (to avoid ping‑ponging back).
     * @returns {void}
     */
    _renderPortalsRecursive(viewerCamera, allPortals, viewMat, projMat, recursionLevel, skipPortal = null) {
        // Stop if we've reached the maximum recursion depth.
        if (recursionLevel >= MAX_RECURSION) return;

        const gl = this.gl;
        // Extract camera position from the view matrix.
        const camPos = new THREE.Vector3().setFromMatrixPosition(viewMat);

        // Iterate over all portals.
        for (const portal of allPortals) {
            // Skip the portal we just came from to avoid infinite ping‑pong.
            if (portal === skipPortal) continue;

            // Determine if the camera is behind the portal (back side).
            const signedDist = portal.signedDistance(camPos);
            const backSide = signedDist < 0;

            // Find the paired portal (exit portal).
            const pair = this._getPair(portal, allPortals);
            if (!pair) continue; // No pair → cannot render through.

            // Which side of the portal disc should be rendered (front or back).
            const side = this._visibleSide(portal, camPos);
            const disc = portal.discMesh;
            const ring = portal.ringMesh;
            const origDiscMat = disc.material;

            // ---- Stamp and fill the portal ----
            // Outer level (recursionLevel === 0): use depth test to occlude with walls.
            if (recursionLevel === 0) {
                // Clear depth within the current stencil mask so the stamp succeeds even behind walls.
                this._clearDepthInStencilMask(gl, recursionLevel);

                // Hide the ring (we only want the disc for stamping).
                ring.visible = false;
                // Set disc material to write only to stencil (no colour or depth).
                disc.material = new THREE.MeshBasicMaterial({
                    colorWrite: false,
                    depthWrite: false,
                    depthTest: true,
                    side: side,
                });
                disc.material.needsUpdate = true;

                // Configure stencil and depth for stamping.
                gl.colorMask(false, false, false, false); // No colour.
                gl.depthMask(false);                       // No depth write.
                gl.enable(gl.DEPTH_TEST);                  // Enable depth testing.
                gl.depthFunc(gl.LEQUAL);                   // Pass if depth <= existing.
                gl.enable(gl.STENCIL_TEST);
                gl.stencilFunc(gl.EQUAL, recursionLevel, 0xFF); // Only where stencil equals current level.
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);         // Increment stencil on pass.
                gl.stencilMask(0xFF);

                // Draw the disc stamp.
                this._renderObject(portal.mesh, viewMat, projMat);

                // Fill the stamped area with background colour (erasing the disc).
                disc.material = new THREE.MeshBasicMaterial({
                    color: this.bgColor,
                    colorWrite: true,
                    depthWrite: false,
                    depthTest: false,
                    stencilWrite: false,
                    side: side,
                });
                gl.colorMask(true, true, true, true);
                gl.depthMask(false);
                gl.disable(gl.DEPTH_TEST);
                gl.stencilMask(0x00);
                gl.stencilFunc(gl.EQUAL, recursionLevel + 1, 0xFF); // Only where stencil was incremented.
                this._renderObject(portal.mesh, viewMat, projMat);

                // Restore disc material and ring visibility.
                disc.material = origDiscMat;
                ring.visible = true;
            } else {
                // ---- Inner level (recursionLevel > 0): clear depth before stamp ----
                // Always succeed by clearing depth in the stencil mask.
                this._clearDepthInStencilMask(gl, recursionLevel);

                ring.visible = false;
                disc.material = new THREE.MeshBasicMaterial({
                    colorWrite: false,
                    depthWrite: false,
                    depthTest: true,
                    side: side,
                });
                disc.material.needsUpdate = true;

                gl.colorMask(false, false, false, false);
                gl.depthMask(false);
                gl.enable(gl.DEPTH_TEST);
                gl.depthFunc(gl.LEQUAL);
                gl.enable(gl.STENCIL_TEST);
                gl.stencilFunc(gl.EQUAL, recursionLevel, 0xFF);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
                gl.stencilMask(0xFF);

                this._renderObject(portal.mesh, viewMat, projMat);

                // Fill with background colour.
                gl.colorMask(true, true, true, true);
                gl.depthMask(false);
                gl.disable(gl.DEPTH_TEST);
                gl.stencilMask(0x00);
                gl.stencilFunc(gl.EQUAL, recursionLevel + 1, 0xFF);
                this._renderObject(portal.mesh, viewMat, projMat);

                disc.material = origDiscMat;
                ring.visible = true;
            }

            // ---- Virtual camera and scene render ----
            // Compute the virtual view matrix (camera at exit portal).
            const virtualView = this._computePortalViewMatrix(portal, pair, viewMat, backSide, recursionLevel);

            // Compute an oblique projection matrix with the exit portal's plane as the near plane.
            let clipPlane = pair.plane;
            if (backSide) {
                clipPlane = pair.plane.clone().negate(); // Flip if coming from back.
            }
            const virtualProj = computeObliqueProjectionMatrix(
                { position: pair.position, rotation: pair.rotation, plane: clipPlane },
                virtualView,
                projMat
            );
            // Extend the far plane to avoid clipping distant geometry.
            this.extendFarPlane(virtualProj);

            // Clear depth within the new stencil level before rendering the scene.
            this._clearDepthInStencilMask(gl, recursionLevel + 1);

            // Configure stencil and depth for the scene render.
            gl.colorMask(true, true, true, true);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.enable(gl.STENCIL_TEST);
            gl.stencilMask(0x00);
            gl.stencilFunc(gl.EQUAL, recursionLevel + 1, 0xFF);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

            // Temporarily hide the entrance disc and the exit portal group.
            const entranceDiscVis = disc.visible;
            const entranceRingVis = ring.visible;
            const pairGroupVis = pair.mesh.visible;
            pair.mesh.visible = false;
            disc.visible = false;
            this._hide(); // Hide capsules and proxies.

            // Render the scene from the virtual camera.
            this._renderScene(this.scene, viewerCamera, virtualView, virtualProj);

            // Restore visibility.
            disc.visible = entranceDiscVis;
            ring.visible = entranceRingVis;
            pair.mesh.visible = pairGroupVis;
            this._show();

            // Recurse further into the **exit portal** (skip the portal we just arrived at).
            this._renderPortalsRecursive(
                viewerCamera,
                allPortals,
                virtualView.clone(),
                virtualProj.clone(),
                recursionLevel + 1,
                pair            // skip the portal we just arrived at
            );

            // ---- Decrement stencil (cleanup) ----
            ring.visible = false;
            disc.material = new THREE.MeshBasicMaterial({
                colorWrite: false,
                depthWrite: false,
                depthTest: false,
                stencilWrite: false,
                side: side,
            });
            gl.colorMask(false, false, false, false);
            gl.depthMask(false);
            gl.disable(gl.DEPTH_TEST);
            gl.stencilMask(0xFF);
            gl.stencilFunc(gl.EQUAL, recursionLevel + 1, 0xFF);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.DECR); // Decrement the stencil value.

            this._renderObject(portal.mesh, viewMat, projMat);
            disc.material = origDiscMat;
            ring.visible = true;
        }
    }

    /**
     * Finds the paired portal for a given portal from a flat list.
     * Assumes the pair is the other portal in the list (single pair per owner).
     * @param {Portal} portal - The portal to find a pair for.
     * @param {Portal[]} allPortals - Flat array of all portals.
     * @returns {Portal|null} The paired portal or null if not found.
     */
    _getPair(portal, allPortals) {
        for (const p of allPortals) if (p !== portal) return p;
        return null;
    }

    /**
     * Renders a single object (or group) using the given view and projection matrices.
     * This is used for stamping portal discs and filling the background.
     * @param {THREE.Object3D} obj - The object to render.
     * @param {THREE.Matrix4} viewMat - View matrix.
     * @param {THREE.Matrix4} projMat - Projection matrix.
     * @returns {void}
     */
    _renderObject(obj, viewMat, projMat) {
        // Temporarily set the temporary scene's children to just this object.
        this.tmpScene.children = [obj];
        // Create a dummy camera with the given matrices.
        const dummy = new THREE.PerspectiveCamera();
        dummy.matrixAutoUpdate = false;
        dummy.matrixWorld.copy(viewMat);
        dummy.matrixWorldInverse.copy(viewMat).invert();
        dummy.projectionMatrix.copy(projMat);
        // Render using the renderer.
        this.renderer.render(this.tmpScene, dummy);
    }

    /**
     * Renders an entire scene using the given view and projection matrices.
     * @param {THREE.Scene} scene - The scene to render.
     * @param {THREE.PerspectiveCamera} camera - The camera (will be temporarily modified).
     * @param {THREE.Matrix4} viewMat - View matrix.
     * @param {THREE.Matrix4} projMat - Projection matrix.
     * @returns {void}
     */
    _renderScene(scene, camera, viewMat, projMat) {
        // Save the current camera matrices.
        const savedView = camera.matrixWorld.clone();
        const savedProj = camera.projectionMatrix.clone();
        // Override the camera's matrices with the virtual ones.
        camera.matrixAutoUpdate = false;
        camera.matrixWorld.copy(viewMat);
        camera.matrixWorldInverse.copy(viewMat).invert();
        camera.projectionMatrix.copy(projMat);
        // Render the scene.
        this.renderer.render(scene, camera);
        // Restore the original matrices.
        camera.matrixAutoUpdate = true;
        camera.matrixWorld.copy(savedView);
        camera.matrixWorldInverse.copy(savedView).invert();
        camera.projectionMatrix.copy(savedProj);
    }

    /**
     * Alias for _renderScene, used for the final pass.
     * @param {THREE.Scene} scene - The scene.
     * @param {THREE.PerspectiveCamera} camera - The camera.
     * @param {THREE.Matrix4} viewMat - View matrix.
     * @param {THREE.Matrix4} projMat - Projection matrix.
     * @returns {void}
     */
    _renderSceneRaw(scene, camera, viewMat, projMat) {
        this._renderScene(scene, camera, viewMat, projMat);
    }

    /**
     * Clears the depth buffer only within the current stencil mask.
     * This ensures that the portal stamp can be drawn without being occluded by existing depth.
     * @param {WebGL2RenderingContext} gl - The WebGL context.
     * @param {number} stencilValue - The stencil value to test against.
     * @returns {void}
     */
    _clearDepthInStencilMask(gl, stencilValue) {
        // Configure stencil: only write to pixels where stencil equals stencilValue.
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, stencilValue, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

        // Disable colour writing, enable depth writing.
        gl.colorMask(false, false, false, false);
        gl.depthMask(true);
        gl.disable(gl.DEPTH_TEST); // We don't want depth testing, just write depth.

        // The clear quad will write a depth of 1.0 (far) everywhere in the stencil mask,
        // effectively clearing any previous depth.
        this.clearDepthQuad.material.depthTest = false;
        this.clearDepthQuad.material.depthWrite = true;
        // Position the quad in clip space (identity matrix).
        this.clearDepthQuad.matrixWorld.identity();
        this.clearDepthQuad.matrixAutoUpdate = false;

        // Create a dummy camera with identity matrices.
        const dummy = new THREE.PerspectiveCamera();
        dummy.matrixAutoUpdate = false;
        dummy.matrixWorld.identity();
        dummy.matrixWorldInverse.identity();
        dummy.projectionMatrix.identity();
        dummy.projectionMatrixInverse.identity();

        // Render the depth‑clearing quad.
        this.tmpScene.children = [this.clearDepthQuad];
        this.renderer.render(this.tmpScene, dummy);
        this.tmpScene.children = [];
    }

    /**
     * Computes the virtual view matrix for the camera at the exit portal.
     * The virtual camera's position and orientation are derived by mapping the original camera
     * through the portal pair transformation (including a 180° rotation).
     * @param {Portal} entrance - The portal the camera is looking through.
     * @param {Portal} exit - The paired portal where the virtual camera should be.
     * @param {THREE.Matrix4} viewMat - Original view matrix.
     * @param {boolean} backSide - Whether the camera is on the back side of the entrance portal.
     * @param {number} recursionLevel - Current recursion depth (not used, but kept for consistency).
     * @returns {THREE.Matrix4} The virtual view matrix.
     */
    _computePortalViewMatrix(entrance, exit, viewMat, backSide, recursionLevel = 0) {
        // Clone the rotations of both portals.
        let eRot = entrance.rotation.clone();
        let xRot = exit.rotation.clone();
        // If we are on the back side, flip both rotations by 180° around Y.
        if (backSide) {
            const flip = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0), Math.PI
            );
            eRot.multiply(flip);
            xRot.multiply(flip);
        }

        // Build transformation matrices from position and rotation.
        let ePos = entrance.position.clone();
        // No offset – the clear‑before‑stamp approach makes it unnecessary.

        const eMat = new THREE.Matrix4().compose(ePos, eRot, new THREE.Vector3(1, 1, 1));
        const xMat = new THREE.Matrix4().compose(exit.position, xRot, new THREE.Vector3(1, 1, 1));

        // Compute the transformation from entrance space to exit space.
        // srcToCam: world -> entrance local (by inverting viewMat * eMat).
        const srcToCam = new THREE.Matrix4().copy(viewMat).invert().multiply(eMat);
        // dstInv: exit local -> world (inverse of exit matrix).
        const dstInv = new THREE.Matrix4().copy(xMat).invert();
        // Combine: world -> entrance local -> mirror Y 180 -> exit local -> world.
        const srcToDst = new THREE.Matrix4().identity()
            .multiply(srcToCam)
            .multiply(this.rotationYMatrix)
            .multiply(dstInv);
        // The virtual view matrix is the inverse of the combined transformation.
        return new THREE.Matrix4().copy(srcToDst).invert();
    }

    /**
     * Disposes of any resources held by the renderer.
     * Currently only clears the temporary scene reference.
     * @returns {void}
     */
    dispose() {
        this.tmpScene = null;
    }
}