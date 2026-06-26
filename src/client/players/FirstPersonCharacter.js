/*
Author: Daniel Yu
Date: March 15, 2026
Description: Manages the local player character: loads the GLTF model, sets up animation mixers
             for upper and lower body, handles equipping/unequipping the portal gun, positions
             the model based on physics state, and updates the camera. It also provides methods
             for mouse look, model scaling, and getting the eye world position for portal detection.
*/

// Import Three.js core for vectors, quaternions, and Euler angles.
import * as THREE from 'three';
// Import the GLTFLoader to load the player model from a .glb file.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Import SkeletonUtils to clone skinned meshes (used for the player model).
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';
// Import client configuration constants (model scale, eye offset, gun placement, etc.).
import { CLIENT_CONFIG } from '../clientConfig.js';
// Import the global game state singleton.
import { GameState } from '../clientState.js';
// Import utility to create a quaternion from yaw (used for model rotation).
import { getYawQuaternion } from '../clientUtils.js';

/**
 * Represents the local player character in the game. This class loads the player model,
 * sets up animation mixers, manages the portal gun model, and updates the camera position
 * and orientation based on the player's physics state and input.
 */
export class FirstPersonCharacter {
    /**
     * Creates a new FirstPersonCharacter instance.
     * @param {THREE.Scene} scene - The Three.js scene to add the model to.
     */
    constructor(scene) {
        // Store a reference to the scene.
        this.scene = scene;

        // The loaded GLTF model (cloned for this instance).
        this.model = null;
        // The head bone of the model (used to position the camera).
        this.headBone = null;
        // The right hand bone (used to attach the portal gun).
        this.rightHandBone = null;
        // The portal gun model (loaded separately).
        this.gunModel = null;
        // The first‑person camera (will be created after model loads).
        this.camera = null;

        // Animation mixers: separate for upper and lower body to allow independent animations.
        this.upperMixer = null;
        this.lowerMixer = null;

        // Lower body animation actions (walk, jump, idle).
        this.lowerActions = {};
        // Upper body locomotion actions (walk, jump, idle) used when gun is not equipped.
        this.upperLocomotionActions = {};
        // The equip/draw animation action.
        this.drawAction = null;

        // Names of the currently playing lower and upper animations.
        this.currentLowerAnim = null;
        this.currentUpperAnim = null;

        // Equip state: whether the portal gun is drawn.
        this.isEquipped = false;
        // Whether an equip/unequip animation is currently playing.
        this.isAnimating = false;
        // Whether the player is in the "hold pose" (arms raised with gun) after equipping.
        this.isHoldingPose = false;
        // Map of bone -> original transforms for the hold pose (to freeze upper body).
        this.holdPose = null;

        // Arrays of bones affected by upper and lower body animations (used for filtering clips).
        this.upperBodyBones = [];
        this.lowerBodyBones = [];

        // Current visual scale (may be changed when held by another player).
        this.visualScale = 1;
        // Offset from head bone to eye position (in local head space).
        this.headToEyeOffset = CLIENT_CONFIG.EYE_OFFSET.clone();
        // Smoothed camera position (used for interpolation, though currently instant).
        this.smoothedCamPos = new THREE.Vector3();

        // Flags to track loading state and pending operations.
        this.modelLoaded = false;
        this.pendingSyncEquip = false;
        this.pendingHoldPose = false;
        this.gunShouldBeVisible = false;

        // Timer for movement detection (used to switch animations).
        this.movingTimer = 0;
        // Distance from the model's origin to its foot (computed from bounding box).
        this.footOffset = 0;

        // Create a temporary camera immediately; it will be repositioned once the model loads.
        this.camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.01, 1000);
        // Assign this camera to the global state so other modules can access it.
        GameState.camera = this.camera;

        // Set a default camera position based on the player's foot position if available.
        if (GameState.localPlayerState && GameState.localPlayerState.position) {
            const footPos = new THREE.Vector3().fromArray(GameState.localPlayerState.position);
            this.camera.position.set(footPos.x, footPos.y + CLIENT_CONFIG.EYE_HEIGHT, footPos.z);
        } else {
            // Otherwise, place the camera at eye height above the origin.
            this.camera.position.set(0, CLIENT_CONFIG.EYE_HEIGHT, 0);
        }
        // Initialise the smoothed position to match the camera.
        this.smoothedCamPos.copy(this.camera.position);

        // Start loading the player model and the portal gun.
        this.loadModel();
        this.loadGun();
    }

    /**
     * Returns the world position of the player's eye (the camera attachment point).
     * This is used for portal crossing detection.
     * @returns {THREE.Vector3} The eye position in world space.
     */
    getEyeWorldPosition() {
        // If the head bone is not available, fall back to the camera position.
        if (!this.headBone) return this.camera.position.clone();
        // Get the world position of the head bone.
        const headPos = this.getHeadWorldPosition();
        // Apply the eye offset scaled by the current visual scale.
        const scaledOffset = this.headToEyeOffset.clone().multiplyScalar(this.visualScale);
        // Return the head position plus the offset.
        return headPos.add(scaledOffset);
    }

    /**
     * Filters an animation clip to keep only tracks for allowed bone names.
     * This is used to separate upper and lower body animations.
     * @param {THREE.AnimationClip} clip - The original animation clip.
     * @param {string[]} allowedBoneNames - Array of normalised bone names to keep.
     * @returns {THREE.AnimationClip|null} The filtered clip, or null if no tracks remain.
     */
    filterAnimationClip(clip, allowedBoneNames) {
        // Filter the tracks to only those whose bone name is in the allowed list.
        const filteredTracks = clip.tracks.filter(track => {
            // Extract the bone name from the track (everything before the last dot).
            const dotIndex = track.name.lastIndexOf('.');
            if (dotIndex === -1) return false;
            let boneName = track.name.substring(0, dotIndex);
            // Normalise the bone name by removing common prefixes and trailing numbers.
            boneName = boneName.replace(/^(mixamorig:|Armature_|Armature\.)/i, '');
            boneName = boneName.replace(/\d+$/, '');
            // Check if the normalised bone name is in the allowed list.
            return allowedBoneNames.includes(boneName);
        });
        // If no tracks remain, return null.
        if (filteredTracks.length === 0) return null;
        // Create a new clip with the filtered tracks.
        return new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
    }

    /**
     * Loads the player GLTF model from the assets folder.
     * Once loaded, it clones the model, sets up bones, initialises animation mixers,
     * and positions the camera.
     * @returns {void}
     */
    loadModel() {
        const loader = new GLTFLoader();
        // Load the player model.
        loader.load(
            'assets/models/thePlayer.glb',
            (gltf) => {
                // Clone the scene so we have an independent instance.
                const model = SkeletonUtils.clone(gltf.scene);
                // Apply the base scale from configuration.
                model.scale.set(CLIENT_CONFIG.MODEL_SCALE, CLIENT_CONFIG.MODEL_SCALE, CLIENT_CONFIG.MODEL_SCALE);
                this.model = model;
                // Add the model to the scene.
                this.scene.add(model);
                // Apply the initial rotation offset (so the model faces the correct direction).
                model.quaternion.copy(CLIENT_CONFIG.MODEL_ROTATION_OFFSET);

                // Compute the foot offset: the distance from the model's origin to the lowest point.
                const box = new THREE.Box3().setFromObject(model);
                this.footOffset = -box.min.y;

                // Arrays to collect upper and lower body bones.
                const upperBones = [];
                const lowerBones = [];

                // Traverse the model to find bones and meshes.
                model.traverse(child => {
                    if (child.isBone) {
                        // Identify head and right hand bones.
                        const name = child.name.toLowerCase();
                        if (name.includes('head')) this.headBone = child;
                        if (name.includes('right') && name.includes('hand')) this.rightHandBone = child;
                        // Categorise bones as upper or lower based on name patterns.
                        if (/spine|neck|head|clavicle|arm|hand|shoulder/.test(name)) {
                            upperBones.push(child);
                            this.upperBodyBones.push(child);
                        }
                        if (/hip|thigh|calf|foot|toe|leg|pelvis/.test(name)) {
                            lowerBones.push(child);
                            this.lowerBodyBones.push(child);
                        }
                    }
                    if (child.isMesh) {
                        // Enable shadows on all meshes.
                        child.castShadow = true;
                        child.receiveShadow = true;
                        // Ensure materials are opaque (no transparency issues).
                        if (child.material) {
                            if (Array.isArray(child.material)) child.material.forEach(m => m.transparent = false);
                            else child.material.transparent = false;
                        }
                        // Tag meshes as local player parts (used for raycasting exclusions).
                        child.userData.isLocalPlayerPart = true;
                    }
                });

                // Normalise bone names for filtering.
                const upperBoneNames = upperBones.map(b => {
                    let n = b.name.replace(/^(mixamorig:|Armature_|Armature\.)/i, '');
                    n = n.replace(/\d+$/, '');
                    return n;
                });
                const lowerBoneNames = lowerBones.map(b => {
                    let n = b.name.replace(/^(mixamorig:|Armature_|Armature\.)/i, '');
                    n = n.replace(/\d+$/, '');
                    return n;
                });

                // Create animation mixers for upper and lower body.
                this.lowerMixer = new THREE.AnimationMixer(model);
                this.upperMixer = new THREE.AnimationMixer(model);

                // Process animations from the GLTF file.
                if (gltf.animations) {
                    const anims = gltf.animations;
                    // Find specific animations by name.
                    const walk = anims.find(a => a.name.toLowerCase().includes('walk') || a.name.toLowerCase().includes('crouch'));
                    const jump = anims.find(a => a.name.toLowerCase().includes('jump'));
                    const idle = anims.find(a => a.name.toLowerCase().includes('idle'));
                    const draw = anims.find(a => a.name.toLowerCase().includes('draw') || a.name.toLowerCase().includes('pull') || a.name.toLowerCase().includes('equip'));

                    // Lower body walk animation.
                    if (walk) {
                        const lowerWalk = this.filterAnimationClip(walk, lowerBoneNames);
                        if (lowerWalk) this.lowerActions.walk = this.lowerMixer.clipAction(lowerWalk).setLoop(THREE.LoopRepeat);
                        const upperWalk = this.filterAnimationClip(walk, upperBoneNames);
                        if (upperWalk) this.upperLocomotionActions.walk = this.upperMixer.clipAction(upperWalk).setLoop(THREE.LoopRepeat);
                    }
                    // Lower body jump animation.
                    if (jump) {
                        const lowerJump = this.filterAnimationClip(jump, lowerBoneNames);
                        if (lowerJump) this.lowerActions.jump = this.lowerMixer.clipAction(lowerJump).setLoop(THREE.LoopRepeat);
                        const upperJump = this.filterAnimationClip(jump, upperBoneNames);
                        if (upperJump) this.upperLocomotionActions.jump = this.upperMixer.clipAction(upperJump).setLoop(THREE.LoopRepeat);
                    }
                    // Lower body idle animation.
                    if (idle) {
                        const lowerIdle = this.filterAnimationClip(idle, lowerBoneNames);
                        if (lowerIdle) this.lowerActions.idle = this.lowerMixer.clipAction(lowerIdle).setLoop(THREE.LoopRepeat);
                        const upperIdle = this.filterAnimationClip(idle, upperBoneNames);
                        if (upperIdle) this.upperLocomotionActions.idle = this.upperMixer.clipAction(upperIdle).setLoop(THREE.LoopRepeat);
                    }
                    // Equip/draw animation (upper body only).
                    if (draw) {
                        const filteredDraw = this.filterAnimationClip(draw, upperBoneNames);
                        if (filteredDraw) {
                            this.drawAction = this.upperMixer.clipAction(filteredDraw);
                            this.drawAction.setLoop(THREE.LoopOnce);
                            this.drawAction.clampWhenFinished = true;
                        }
                    }
                }

                // Start lower and upper idle animations.
                if (this.lowerActions.idle) {
                    this.lowerActions.idle.play();
                    this.currentLowerAnim = 'idle';
                }
                if (this.upperLocomotionActions.idle) {
                    this.upperLocomotionActions.idle.play();
                    this.currentUpperAnim = 'idle';
                }

                // Position the camera using the head bone.
                const headPos = this.getHeadWorldPosition();
                this.smoothedCamPos.copy(headPos).add(this.headToEyeOffset);
                this.camera.position.copy(this.smoothedCamPos);

                // Mark model as loaded and process any pending operations.
                this.modelLoaded = true;
                if (this.pendingSyncEquip) {
                    this.syncEquip();
                    this.pendingSyncEquip = false;
                }
                if (this.pendingHoldPose) {
                    this.applyHoldPose();
                }
                // If the gun should be visible, show it now.
                if (this.gunShouldBeVisible && this.gunModel) {
                    this.gunModel.visible = true;
                }
            },
            undefined,
            (error) => this.createFallback() // If loading fails, create a simple box character.
        );
    }

    /**
     * Loads the portal gun model from the assets folder and attaches it to the right hand bone.
     * @returns {void}
     */
    loadGun() {
        const loader = new GLTFLoader();
        loader.load(
            'assets/models/portalGun.glb',
            (gltf) => {
                const gun = gltf.scene;
                // Apply the gun scale from configuration.
                gun.scale.set(CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE);
                // Initially hide the gun.
                gun.visible = false;
                this.gunModel = gun;
                // Try to attach the gun to the right hand bone; retry if bone not yet available.
                const tryAttach = () => {
                    if (this.rightHandBone) {
                        // Add the gun as a child of the right hand bone.
                        this.rightHandBone.add(gun);
                        // Position and rotate the gun relative to the hand.
                        gun.position.copy(CLIENT_CONFIG.GUN_POSITION);
                        gun.rotation.set(CLIENT_CONFIG.GUN_ROTATION.x, CLIENT_CONFIG.GUN_ROTATION.y, CLIENT_CONFIG.GUN_ROTATION.z);
                        // Tag all gun meshes as local player parts.
                        gun.traverse((child) => {
                            if (child.isMesh) child.userData.isLocalPlayerPart = true;
                        });
                    } else {
                        // If the hand bone is not available, retry in 100ms.
                        setTimeout(tryAttach, 100);
                    }
                };
                tryAttach();
                // If the gun should be visible (e.g., after equip), show it.
                if (this.gunShouldBeVisible) {
                    this.gunModel.visible = true;
                }
            }
        );
    }

    /**
     * Gets the world position of the head bone.
     * @returns {THREE.Vector3} The head position in world space.
     */
    getHeadWorldPosition() {
        if (!this.headBone) return new THREE.Vector3(0, 0, 0);
        // Ensure the model's world matrix is up to date.
        this.model.updateWorldMatrix(true, true);
        // Get the head bone's world position.
        return this.headBone.getWorldPosition(new THREE.Vector3());
    }

    /**
     * Fallback when the model fails to load – creates a simple box character.
     * @returns {void}
     */
    createFallback() {
        // Create a group to hold the body and head boxes.
        const group = new THREE.Group();
        // Body: a box of size 0.8 x 1.6 x 0.8 with a colour.
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 0.8), bodyMat);
        body.position.y = 0.8;
        body.castShadow = true;
        group.add(body);
        // Head: a smaller box on top.
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffccaa });
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), headMat);
        head.position.y = 1.6 + 0.3;
        head.castShadow = true;
        group.add(head);
        // Add the group to the scene.
        this.scene.add(group);
        // Store the group as the model and set bone references.
        this.model = group;
        this.headBone = group;
        this.rightHandBone = group;
        this.upperBodyBones = [group];
        this.lowerBodyBones = [group];
        this.visualScale = 1;
        this.footOffset = 0;
        this.headToEyeOffset = CLIENT_CONFIG.EYE_OFFSET.clone();
        // Position the camera.
        const headPos = this.getHeadWorldPosition();
        this.smoothedCamPos.copy(headPos).add(this.headToEyeOffset);
        this.camera.position.copy(this.smoothedCamPos);
        // Mark as loaded and process pending operations.
        this.modelLoaded = true;
        if (this.pendingSyncEquip) {
            this.syncEquip();
            this.pendingSyncEquip = false;
        }
        if (this.pendingHoldPose) {
            this.applyHoldPose();
        }
        if (this.gunShouldBeVisible && this.gunModel) {
            this.gunModel.visible = true;
        }
    }

    /**
     * Sets the rotation of the entire model.
     * @param {THREE.Quaternion} quat - The new rotation quaternion.
     * @returns {void}
     */
    setModelRotation(quat) {
        if (this.model) this.model.quaternion.copy(quat);
    }

    /**
     * Sets the visual scale of the model (used when held by another player).
     * @param {number} scaleMultiplier - The scale factor.
     * @returns {void}
     */
    setModelScale(scaleMultiplier) {
        if (this.model) {
            this.visualScale = Math.max(scaleMultiplier, 0.01);
            const totalScale = CLIENT_CONFIG.MODEL_SCALE * this.visualScale;
            this.model.scale.set(totalScale, totalScale, totalScale);
        }
    }

    /**
     * Synchronises the equip state with the worker. This is used when reconnecting
     * or when the worker tells us the player is equipped but we haven't played the animation.
     * It jumps to the end of the draw animation and freezes the upper body in the hold pose.
     * @returns {void}
     */
    syncEquip() {
        // If the model isn't loaded yet, defer the operation.
        if (!this.modelLoaded) {
            this.pendingSyncEquip = true;
            return;
        }
        // If already equipped or in hold pose or animating, do nothing.
        if (!this.isEquipped || this.isHoldingPose || this.isAnimating) return;
        if (this.drawAction) {
            this.isAnimating = false;
            this.drawAction.stop();
            // Set the animation time to the end of the clip.
            this.drawAction.time = this.drawAction.getClip().duration;
            this.drawAction.play();
            // Update the mixer immediately to apply the pose.
            if (this.upperMixer) this.upperMixer.update(0);
            // After a short delay, freeze the upper body bones.
            setTimeout(() => {
                this.drawAction.stop();
                // Store the current transform of each upper body bone.
                this.holdPose = new Map();
                this.upperBodyBones.forEach(bone => {
                    this.holdPose.set(bone, {
                        pos: bone.position.clone(),
                        quat: bone.quaternion.clone(),
                        scale: bone.scale.clone(),
                    });
                });
                this.isHoldingPose = true;
                this.gunShouldBeVisible = true;
                if (this.gunModel) this.gunModel.visible = true;
                // Notify the worker that we are now in hold pose.
                if (GameState.worker && GameState.playerId) {
                    GameState.worker.port.postMessage({ type: 'set_hold_pose', inHoldPose: true });
                }
            }, 10);
        }
    }

    /**
     * Instantly applies the equipped hold pose without playing the animation.
     * Used when reconnecting while already equipped.
     * @returns {void}
     */
    applyHoldPose() {
        // If model isn't loaded, defer.
        if (!this.modelLoaded) {
            this.pendingHoldPose = true;
            return;
        }
        this.pendingHoldPose = false;
        if (this.isHoldingPose) return;

        // Stop any current upper body locomotion animation.
        if (this.currentUpperAnim && this.upperLocomotionActions[this.currentUpperAnim]) {
            this.upperLocomotionActions[this.currentUpperAnim].stop();
        }

        // Set the draw action to its end time and play it to apply the final pose.
        const dur = this.drawAction.getClip().duration;
        this.drawAction.time = dur;
        this.drawAction.play();
        this.upperMixer.update(0);

        // Freeze the upper body bones.
        this.holdPose = new Map();
        this.upperBodyBones.forEach(bone => {
            this.holdPose.set(bone, {
                pos: bone.position.clone(),
                quat: bone.quaternion.clone(),
                scale: bone.scale.clone(),
            });
        });
        this.isHoldingPose = true;
        this.isEquipped = true;
        this.isAnimating = false;
        this.currentUpperAnim = null;
        this.drawAction.stop();

        // Ensure gun is visible.
        this.gunShouldBeVisible = true;
        if (this.gunModel) this.gunModel.visible = true;
    }

    /**
     * Updates the character every frame. This includes:
     * - Updating animation mixers.
     * - Applying the hold pose if active.
     * - Positioning the model based on the physics state.
     * - Rotating the model based on yaw.
     * - Updating the camera position (unless in detached portal mode).
     * - Selecting animations based on movement state.
     * @param {number} deltaTime - Time elapsed since the last update in seconds.
     * @returns {void}
     */
    update(deltaTime) {
        // If the model is not available, do nothing.
        if (!this.model) return;

        // Update animation mixers.
        if (this.lowerMixer) this.lowerMixer.update(deltaTime);
        if (this.upperMixer) {
            // If an equip/unequip animation is playing, update the mixer.
            if (this.isAnimating && (this.currentUpperAnim === 'draw' || this.currentUpperAnim === 'unequip')) {
                this.upperMixer.update(deltaTime);
            } else if (!this.isHoldingPose && !this.isAnimating && this.currentUpperAnim) {
                // Otherwise, update the upper mixer for locomotion animations.
                this.upperMixer.update(deltaTime);
            }
        }

        // If in hold pose, freeze the upper body bones to their stored transforms.
        if (this.isHoldingPose && this.holdPose) {
            this.upperBodyBones.forEach(bone => {
                const pose = this.holdPose.get(bone);
                if (pose) {
                    bone.position.copy(pose.pos);
                    bone.quaternion.copy(pose.quat);
                    bone.scale.copy(pose.scale);
                }
            });
        }

        // Position the model based on the foot position from the worker state.
        if (GameState.localPlayerState) {
            const footPos = new THREE.Vector3().fromArray(GameState.localPlayerState.position);
            const totalScale = CLIENT_CONFIG.MODEL_SCALE * this.visualScale;
            const scaledFootOffset = this.footOffset * totalScale;
            // Place the model so its feet align with the foot position.
            this.model.position.set(footPos.x, footPos.y + scaledFootOffset, footPos.z);

            // Ensure the model's feet are exactly on the ground (correct for any offset).
            const box = new THREE.Box3().setFromObject(this.model);
            const bottom = box.min.y;
            const diff = bottom - footPos.y;
            if (Math.abs(diff) > 0.001) {
                this.model.position.y -= diff;
            }
        }

        // Rotate the model based on yaw (unless being held by another player).
        if (!GameState.isBeingHeld) {
            let displayYaw = GameState.rawYaw;
            // If equipped and in hold pose, add an extra yaw offset to simulate holding the gun.
            if (this.isEquipped && this.isHoldingPose) {
                displayYaw += CLIENT_CONFIG.EXTRA_YAW_DEGREES;
            }
            const yawQuat = getYawQuaternion(displayYaw);
            this.model.quaternion.copy(CLIENT_CONFIG.MODEL_ROTATION_OFFSET.clone().multiply(yawQuat));
        }

        // Update camera position (only if not in detached portal mode).
        if (!GameState.cameraDetached) {
            // Get the raw head position.
            const rawHeadPos = this.getHeadWorldPosition();
            // Apply the eye offset scaled by the visual scale.
            const scaledEyeOffset = this.headToEyeOffset.clone().multiplyScalar(this.visualScale);
            const targetCamPos = rawHeadPos.clone().add(scaledEyeOffset);

            // Snap the camera instantly to the target position (no smoothing).
            this.camera.position.copy(targetCamPos);
            // Keep the smoothed position in sync.
            this.smoothedCamPos.copy(targetCamPos);

            // Camera orientation.
            if (GameState.isBeingHeld) {
                // If being held, orient the camera to look in the direction of the head bone.
                if (this.headBone) {
                    const headQuat = this.headBone.getWorldQuaternion(new THREE.Quaternion());
                    // Rotate 180° around Y to look forward from the head's local orientation.
                    const yaw180 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
                    const finalQuat = headQuat.clone().multiply(yaw180);
                    this.camera.quaternion.copy(finalQuat);
                }
            } else {
                // Normal first-person: use the yaw and pitch from input.
                this.camera.quaternion.setFromEuler(new THREE.Euler(GameState.pitch, GameState.rawYaw, 0, 'YXZ'));
            }
        }

        // Animation selection based on movement state.
        if (GameState.localPlayerState && !GameState.isBeingHeld) {
            const vel = GameState.localPlayerState.velocity || [0, 0, 0];
            const speed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
            const onGround = GameState.localPlayerState.onGround;
            const isRising = vel[1] > 0.5;

            // Update the moving timer: if moving, set to timeout; otherwise, decrement.
            if (speed > CLIENT_CONFIG.MOVING_SPEED_THRESHOLD) this.movingTimer = CLIENT_CONFIG.MOVING_TIMEOUT;
            else if (this.movingTimer > 0) this.movingTimer -= deltaTime;

            const moving = this.movingTimer > 0;

            // Determine the target lower body animation.
            let targetLower = null;
            if (!onGround) {
                if (isRising) targetLower = 'jump';
                else targetLower = 'idle';
            } else if (moving) {
                targetLower = 'walk';
            } else {
                targetLower = 'idle';
            }

            // Transition lower body animation.
            if (targetLower && this.lowerActions[targetLower] && this.currentLowerAnim !== targetLower) {
                if (this.currentLowerAnim && this.lowerActions[this.currentLowerAnim]) {
                    this.lowerActions[this.currentLowerAnim].fadeOut(0.2);
                }
                this.lowerActions[targetLower].reset().fadeIn(0.2).play();
                this.currentLowerAnim = targetLower;
            }

            // Upper body locomotion when not equipped and not animating.
            if (!this.isEquipped && !this.isAnimating && !this.isHoldingPose) {
                const targetUpper = targetLower;
                if (targetUpper && this.upperLocomotionActions[targetUpper] && this.currentUpperAnim !== targetUpper) {
                    if (this.currentUpperAnim && this.upperLocomotionActions[this.currentUpperAnim]) {
                        this.upperLocomotionActions[this.currentUpperAnim].fadeOut(0.2);
                    }
                    this.upperLocomotionActions[targetUpper].reset().fadeIn(0.2).play();
                    this.currentUpperAnim = targetUpper;
                }
            }
        }
    }

    /**
     * Equips the portal gun: plays the draw animation and enters the hold pose.
     * @returns {void}
     */
    equip() {
        // If already equipped or animating, do nothing.
        if (this.isEquipped || this.isAnimating) return;
        this.isAnimating = true;
        this.isEquipped = true;
        this.isHoldingPose = false;
        this.gunShouldBeVisible = true;
        if (this.gunModel) this.gunModel.visible = true;

        if (this.drawAction) {
            // Fade out any current upper locomotion animation.
            if (this.currentUpperAnim && this.upperLocomotionActions[this.currentUpperAnim]) {
                this.upperLocomotionActions[this.currentUpperAnim].fadeOut(0.2);
            }
            // Play the draw animation.
            this.drawAction.reset().play();
            this.currentUpperAnim = 'draw';

            // When the animation finishes, enter the hold pose.
            const onFinish = () => {
                if (this.upperMixer) this.upperMixer.update(0);
                // Store the current transforms of upper body bones.
                this.holdPose = new Map();
                this.upperBodyBones.forEach(bone => {
                    this.holdPose.set(bone, {
                        pos: bone.position.clone(),
                        quat: bone.quaternion.clone(),
                        scale: bone.scale.clone(),
                    });
                });
                this.isHoldingPose = true;
                this.isAnimating = false;
                this.currentUpperAnim = null;
                this.drawAction.stop();

                // Notify the worker of the hold pose.
                if (GameState.worker && GameState.playerId) {
                    GameState.worker.port.postMessage({ type: 'set_hold_pose', inHoldPose: true });
                }

                // Remove the event listener.
                this.upperMixer.removeEventListener('finished', onFinish);
            };
            this.upperMixer.addEventListener('finished', onFinish);
        } else {
            // If no draw action, just set the state.
            this.isAnimating = false;
        }
        // Notify the worker that the player is equipped.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({ type: 'equip', equipped: true });
        }
    }

    /**
     * Unequips the portal gun: plays the reverse animation and hides the gun.
     * @returns {void}
     */
    unequip() {
        // If not equipped or animating, do nothing.
        if (!this.isEquipped || this.isAnimating) return;
        this.isAnimating = true;
        this.isEquipped = false;
        this.isHoldingPose = false;
        this.holdPose = null;
        this.gunShouldBeVisible = false;

        if (this.drawAction) {
            const dur = this.drawAction.getClip().duration;
            this.drawAction.stop();
            // Play the animation in reverse.
            this.drawAction.timeScale = -1;
            this.drawAction.time = dur;
            this.drawAction.play();
            this.currentUpperAnim = 'unequip';

            // When the reverse animation finishes, hide the gun and reset.
            const onFinish = () => {
                this.drawAction.timeScale = 1;
                if (this.gunModel) this.gunModel.visible = false;
                this.isAnimating = false;
                this.currentUpperAnim = null;
                this.drawAction.stop();

                // Notify the worker that hold pose is cleared.
                if (GameState.worker && GameState.playerId) {
                    GameState.worker.port.postMessage({ type: 'set_hold_pose', inHoldPose: false });
                }

                this.upperMixer.removeEventListener('finished', onFinish);
                // Restart upper locomotion animation if there is a lower animation.
                if (this.currentLowerAnim && this.upperLocomotionActions[this.currentLowerAnim]) {
                    this.upperLocomotionActions[this.currentLowerAnim].reset().fadeIn(0.2).play();
                    this.currentUpperAnim = this.currentLowerAnim;
                }
            };
            this.upperMixer.addEventListener('finished', onFinish);
        } else {
            // If no draw action, just hide the gun.
            if (this.gunModel) this.gunModel.visible = false;
            this.isAnimating = false;
        }
        // Notify the worker of unequip.
        if (GameState.worker && GameState.playerId) {
            GameState.worker.port.postMessage({ type: 'equip', equipped: false });
        }
    }

    /**
     * Toggles the equip/unequip state.
     * @returns {void}
     */
    toggleEquip() {
        if (this.isAnimating) return;
        if (this.isEquipped) this.unequip();
        else this.equip();
    }

    /**
     * Handles mouse movement to update the yaw and pitch for camera rotation.
     * @param {number} deltaX - Change in mouse X (in pixels).
     * @param {number} deltaY - Change in mouse Y (in pixels).
     * @param {number} [sensitivity=0.002] - Mouse sensitivity multiplier.
     * @returns {void}
     */
    handleMouseMove(deltaX, deltaY, sensitivity = 0.002) {
        // Update raw yaw (horizontal) and pitch (vertical).
        GameState.rawYaw -= deltaX * sensitivity;
        GameState.pitch -= deltaY * sensitivity;
        // Clamp pitch to prevent looking upside down.
        GameState.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, GameState.pitch));
    }

    /**
     * Locks the pointer to enter first‑person mode.
     * @returns {void}
     */
    lock() {
        document.body.requestPointerLock();
    }
}