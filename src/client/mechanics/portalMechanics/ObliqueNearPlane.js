/*
Author: Daniel Yu
Date: April 24, 2026
Description: Computes an oblique projection matrix whose near clipping plane is aligned with a portal surface.
             This is essential for rendering portal views correctly: by shearing the view frustum, the near plane
             exactly coincides with the portal disc, preventing geometry from being clipped incorrectly.
             The implementation is based on Eric Lengyel's well-known algorithm for oblique near-plane clipping,
             which modifies a standard perspective projection matrix using a clip-space plane equation.
*/

// Import the Three.js core library for matrix, vector, and quaternion operations.
import * as THREE from 'three';

/**
 * Creates a new projection matrix derived from the input projection matrix (`projMat`),
 * with its near plane replaced by the plane of the given portal, transformed into camera space.
 * This oblique projection ensures that objects behind the portal are rendered correctly
 * without being clipped by the original near plane.
 *
 * @param {Object} portal - An object representing the portal. Must contain a `THREE.Plane` named `plane`,
 *                          and position/rotation for context (though only the plane is used here).
 * @param {THREE.Matrix4} viewMat - The view matrix of the virtual camera looking through the portal.
 *                                   Used to transform the portal plane into camera space.
 * @param {THREE.Matrix4} projMat - The standard perspective projection matrix to modify.
 * @returns {THREE.Matrix4} A new projection matrix with the oblique near plane applied.
 */
export function computeObliqueProjectionMatrix(portal, viewMat, projMat) {
    // Step 1: Retrieve the portal's clipping plane in world space.
    // The plane's normal points outward from the portal surface, and its constant defines the distance from the origin.
    const clipPlaneWS = portal.plane.clone();

    // Step 2: Transform the world-space plane into camera space (view space).
    // In camera space, the view matrix is the identity, so we multiply by the inverse view matrix.
    // This effectively expresses the plane equation in the camera's local coordinate system.
    const cameraInverseViewMat = new THREE.Matrix4().copy(viewMat).invert();
    const clipPlaneCS = clipPlaneWS.applyMatrix4(cameraInverseViewMat);

    // Step 3: Extract the coefficients (a, b, c, d) of the camera-space plane equation: a*x + b*y + c*z + d = 0.
    // These coefficients form a 4D vector used to modify the projection matrix.
    const clipVector = new THREE.Vector4(
        clipPlaneCS.normal.x,   // a: x-coefficient
        clipPlaneCS.normal.y,   // b: y-coefficient
        clipPlaneCS.normal.z,   // c: z-coefficient
        clipPlaneCS.constant    // d: constant term
    );

    // Step 4: Begin building the oblique projection matrix by cloning the original projection matrix.
    const projectionMatrix = projMat.clone();

    // Step 5: Compute the 'q' vector, which is used to determine how much to shear the projection.
    // This is the core of Lengyel's algorithm: q is a point on the near plane in clip space.
    const q = new THREE.Vector4();

    // Compute q.x using the sign of the x-component of the clip vector and the projection matrix elements.
    // The denominator (projectionMatrix.elements[0]) is the scaling factor for the X axis (m11).
    q.x = (Math.sign(clipVector.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];

    // Compute q.y similarly using the y-component and the Y-axis scaling factor (m22).
    q.y = (Math.sign(clipVector.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];

    // Set q.z to -1.0, as the near plane in clip space is at z = -1 (before perspective division).
    q.z = -1.0;

    // Compute q.w using the W component of the projection matrix (m34), which controls the depth mapping.
    q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

    // Step 6: Compute the dot product of the clip vector and q.
    // This value determines the scaling factor needed to align the near plane.
    const dot = clipVector.dot(q);

    // Step 7: If the dot product is extremely close to zero, the plane is parallel to the view direction
    // and cannot be used for oblique clipping. In this case, return the unmodified projection matrix.
    if (Math.abs(dot) < 1e-100) {
        return projectionMatrix;
    }

    // Step 8: Scale the clip vector so that the resulting dot product equals 2.0.
    // This satisfies the equation: clipVector · q = 2, which is required to map the near plane to z = -1.
    clipVector.multiplyScalar(2.0 / dot);

    // Step 9: Overwrite the third row of the projection matrix with the modified clip vector coefficients.
    // The third row of the projection matrix defines the mapping for the Z and W coordinates.
    // By replacing it, we effectively shear the frustum so that the near plane becomes the portal plane.
    projectionMatrix.elements[2] = clipVector.x;  // m13: affects the x-component of the clip-space Z.
    projectionMatrix.elements[6] = clipVector.y;  // m23: affects the y-component of the clip-space Z.
    projectionMatrix.elements[10] = clipVector.z + 1.0; // m33: adds 1.0 to maintain the near-plane mapping.
    projectionMatrix.elements[14] = clipVector.w;  // m43: affects the W-component of the clip-space Z.

    // Step 10: Return the newly constructed oblique projection matrix.
    // This matrix can now be used to render the scene from the portal's point of view
    // without clipping the portal geometry itself.
    return projectionMatrix;
}