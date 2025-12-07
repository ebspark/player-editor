/**
 * @file Main script for the 3D application.
 * Handles scene setup, rendering, model loading, player management,
 * and UI interactions for item previews and customization.
 */

// --- GLSL SHADERS ---

/**
 * Vertex shader for the skybox.
 * Positions the sky sphere relative to the camera without perspective.
 */
const skyVS = `
    varying vec3 vWorldPosition;

    void main()
    {
        // Rotate the position based on modelViewMatrix but ignore translation
        vec3 rotatedPosition = (modelViewMatrix * vec4(position, 0.0)).xyz;
        // Set gl_Position, forcing z to w for depth testing (sky is always behind)
        gl_Position = projectionMatrix * vec4(rotatedPosition, 0.0);
        gl_Position.z = gl_Position.w;

        vWorldPosition = position;
    }`;

/**
 * Fragment shader for the skybox.
 * Renders a gradient fog and a sun based on direction.
 */
const skyFS = `
    varying vec3 vWorldPosition;

    uniform vec3 cameraFogColor0; // Horizon color
    uniform vec3 cameraFogColor1; // Zenith (top) color
    uniform float sunSize;

    uniform vec3 sunColor;
    uniform vec3 sunDirection;

    void main()
    {
        vec3 cameraToVertex = normalize(vWorldPosition);

        // Calculate fog color based on vertical angle (horizonFactor)
        float horizonFactor = 1.0 - clamp(abs(cameraToVertex.y) / 0.8, 0.0, 1.0);
        vec3 fogColor = mix(cameraFogColor1.rgb, cameraFogColor0.rgb, horizonFactor * horizonFactor);
        vec4 color = vec4(fogColor, 1.0);

        // Calculate sun effect
        float sunAngle = acos(dot(sunDirection, -cameraToVertex));
        float realSunSize = 0.05 * sunSize;
        float sunGlowSize = sunSize;
        float sunFactor = clamp((sunGlowSize - sunAngle) / sunGlowSize, 0.0, 1.0);
        sunFactor *= sunFactor; // Square for a sharper falloff
        if(sunAngle < realSunSize) sunFactor = 1.5; // Bright core
        color.rgb = mix(color.rgb, sunColor, sunFactor); // Blend sun color

        gl_FragColor = color;
        #include <colorspace_fragment> // Apply Three.js color space correction
    }`;

// --- GLOBAL VARIABLES ---

let scene, camera, renderer, controls, transformControls;
window.scene = null; // Expose scene globally (legacy?)

// For selection outlining
let selectionMaskTarget;
let selectionMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff // White material for writing to the selection mask
});
let blackMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000 // Black material for non-selected objects in the mask
});
let selectedObjectsForOutline = [];
let composer, outlinePass;

// SGM Worker Pool
let sgmWorkerPool;

// Multi-selection
let multiSelectGroup = null;

// Player & Item Management
let selectedPlayer = null;
window.shopItems = {}; // Global cache for item configurations
let previewCache = new Map(); // Caches generated preview models

// UI Components
let genericItemGrid; // (Unused in provided code)
let selectionBox, selectionHelper; // For box selection
let previewGrid; // For the attachment preview bar

// Attachment Mode
window.attachmentMode = 'child'; // 'child' or 'parent'

// (Removed previewMannequin globals as the feature was removed)


/**
 * Toggles the attachment editing mode between 'child' and 'parent'.
 * Updates the UI button and refreshes the JSON editor and preview bar.
 */
window.toggleAttachmentMode = function () {
    const btn = document.getElementById('jsonAttachmentModeToggle'); // <-- NEW ID
    if (window.attachmentMode === 'child') {
        window.attachmentMode = 'parent';
        btn.innerText = 'Attachment Points'; // <-- NEW TEXT
        btn.style.color = '#ff5555';
    } else {
        window.attachmentMode = 'child';
        btn.innerText = 'Attachment Point Overrides'; // <-- NEW TEXT
        btn.style.color = '#55ff55';
    }

    // Refresh JSON editor if it exists
    if (window.updateJsonEditorContent && selectedObjectsForOutline) {
        window.updateJsonEditorContent(selectedObjectsForOutline);
    }

    // Refresh attachment preview bar if it exists
    if (window.updateAttachmentPreview && selectedObjectsForOutline && selectedObjectsForOutline.length > 0) {
        window.updateAttachmentPreview(selectedObjectsForOutline[0]);
    }
};

/**
 * Fetches the global shop item configuration from the API.
 */
async function fetchShopItems() {
    try {
        const response = await fetch('https://api.slin.dev/grab/v1/get_shop_items?version=3');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        window.shopItems = await response.json();
        previewCache.clear(); // Clear preview cache as item data has changed
        console.log('✅ Shop items loaded globally.');
    } catch (error) {
        console.error('❌ Failed to fetch global shop items:', error);
        alert('Could not load item data. Some features may not work.');
    }
}


/**
 * Handles the selection of a local file for importing into the scene.
 * This function is triggered by the 'onchange' event of file input elements.
 * It supports .sgm, .glb, and .obj file formats.
 * @param {Event} event - The file input change event.
 */
function handleFileSelection(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    const filename = file.name;
    const extension = filename.split('.').pop().toLowerCase();
    const objectURL = URL.createObjectURL(file); // Create a temporary URL for the file

    /** Callback for when a model is successfully loaded */
    const onModelLoaded = (model) => {
        model.name = filename;
        scene.add(model);
        console.log(`Successfully imported ${filename}`);
        URL.revokeObjectURL(objectURL); // Clean up the temporary URL
    };

    /** Callback for when model loading fails */
    const onError = (error) => {
        console.error(`Error loading file ${filename}:`, error);
        alert(`Failed to load ${filename}. See console for details.`);
        URL.revokeObjectURL(objectURL);
    };

    // Load based on file extension
    switch (extension) {
        case 'sgm':
            {
                // Use the SGM loader worker pool
                const sgmLoaderInstance = new SGMLoader();
                sgmWorkerPool.run({
                    fileUrl: objectURL
                }, (data) => {
                    const {
                        status,
                        meshData,
                        materialData,
                        animFilename,
                        error
                    } = data;

                    if (status === 'error') {
                        onError(error);
                        return;
                    }

                    // Reconstruct the model from worker data
                    const group = sgmLoaderInstance.createGroupFromMeshes(meshData, materialData);

                    if (animFilename) {
                        console.warn(`SGM model references an animation file ('${animFilename}'), but it cannot be loaded from a local import. Skinned meshes will be converted to static meshes.`);
                        sgmLoaderInstance.convertSkinnedMeshesToStaticMeshes(group);
                    }

                    onModelLoaded(group);
                });
                break;
            }

        case 'glb':
        case 'gltf':
            {
                const loader = new THREE.GLTFLoader();
                loader.load(objectURL, (gltf) => {
                    onModelLoaded(gltf.scene);
                }, undefined, onError);
                break;
            }

        case 'obj':
            {
                const loader = new THREE.OBJLoader();
                loader.load(objectURL, (obj) => {
                    onModelLoaded(obj);
                }, undefined, onError);
                break;
            }

        default:
            alert(`Unsupported file type: .${extension}`);
            console.warn(`Unsupported file type: .${extension}`);
            URL.revokeObjectURL(objectURL);
            break;
    }


    event.target.value = ''; // Reset file input
}

/**
 * Gets the dimensions of the canvas container.
 * @returns {object} Dimensions including width, height, pixelWidth, pixelHeight, and dpr.
 */
function getCanvasSize() {
    const rect = document.getElementById('canvas-container').getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return {
        width: rect.width,
        height: rect.height,
        pixelWidth: rect.width * dpr, // For render targets
        pixelHeight: rect.height * dpr, // For render targets
        dpr // Device Pixel Ratio
    };
}


/**
 * Initializes the main Three.js scene, camera, renderer, controls, and effects.
 */
function initScene() {
    // Initialize the worker pool for loading SGM models
    sgmWorkerPool = new WorkerPool('./SGMWorker.js');

    // --- Scene ---
    window.scene = new THREE.Scene();
    scene = window.scene;

    // --- Skybox ---
    const sunAngle = new THREE.Euler(THREE.MathUtils.degToRad(45), THREE.MathUtils.degToRad(315), 0.0);
    const sunAltitude = 45.0;
    const horizonColor = [0.916, 0.9574, 0.9574];
    const zenithColor = [0.28, 0.476, 0.73];
    const sunDirection = new THREE.Vector3(0, 0, 1).applyEuler(sunAngle);

    // Calculate sun color based on altitude
    let sunColorFactor = 1.0 - sunAltitude / 90.0;
    sunColorFactor *= sunColorFactor;
    sunColorFactor = 1.0 - sunColorFactor;
    sunColorFactor *= 0.8;
    sunColorFactor += 0.2;
    const sunColor = [
        horizonColor[0] * (1.0 - sunColorFactor) + sunColorFactor,
        horizonColor[1] * (1.0 - sunColorFactor) + sunColorFactor,
        horizonColor[2] * (1.0 - sunColorFactor) + sunColorFactor,
    ];

    // Create sky material using the custom shaders
    const skyMaterial = new THREE.ShaderMaterial({
        vertexShader: skyVS,
        fragmentShader: skyFS,
        uniforms: {
            cameraFogColor0: { value: horizonColor },
            cameraFogColor1: { value: zenithColor },
            sunSize: { value: 1.0 },
            sunColor: { value: sunColor },
            sunDirection: { value: sunDirection.clone() }
        },
        side: THREE.BackSide, // Render on the inside of the sphere
        depthWrite: false, // Sky should not write to depth buffer
        flatShading: false,
    });

    const skyGeometry = new THREE.SphereGeometry(500, 32, 16);
    const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    skyMesh.renderOrder = 1000; // Render sky last (or very late)
    skyMesh.frustumCulled = false; // Always render sky
    skyMesh.userData.ignoreInRaycast = true; // Click-through the sky
    scene.add(skyMesh);

    // --- Renderer ---
    const { width, height, pixelWidth, pixelHeight, dpr } = getCanvasSize();
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = false; // Shadows disabled
    const canvasContainer = document.getElementById('canvas-container');
    canvasContainer.appendChild(renderer.domElement);

    // --- Camera ---
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 2.25, 5);

    // --- Controls ---
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; // Smooth camera movement

    // --- Post-Processing (Outline Effect) ---
    composer = new THREE.EffectComposer(renderer);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);

    // 1. Render pass (renders the main scene)
    const renderPass = new THREE.RenderPass(scene, camera);
    composer.addPass(renderPass);

    // 2. Custom Outline Shader Pass
    const OutlineShader = {
        uniforms: {
            'tDiffuse': { value: null }, // Main scene render
            'tSelectionMask': { value: null }, // Mask of selected objects
            'uOutlineColor': { value: new THREE.Color(0xffa500) }, // Orange
            'uResolution': { value: new THREE.Vector2(pixelWidth, pixelHeight) }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader:
            `
            uniform sampler2D tDiffuse;
            uniform sampler2D tSelectionMask;
            uniform vec3 uOutlineColor;
            uniform vec2 uResolution;
            varying vec2 vUv;

            void main() {
                vec4 baseColor = texture2D(tDiffuse, vUv);
                vec4 ownMaskColor = texture2D(tSelectionMask, vUv);

                // If this pixel is not selected, just render the base scene
                if (ownMaskColor.r == 0.0 && ownMaskColor.g == 0.0 && ownMaskColor.b == 0.0) {
                    gl_FragColor = baseColor;
                    return;
                }

                // Check neighbors in the mask texture to find edges
                vec2 texelSize = 1.0 / uResolution;
                float isEdge = 0.0;
                vec4 neighborN = texture2D(tSelectionMask, vUv + vec2(0.0, texelSize.y));
                vec4 neighborS = texture2D(tSelectionMask, vUv - vec2(0.0, texelSize.y));
                vec4 neighborE = texture2D(tSelectionMask, vUv + vec2(texelSize.x, 0.0));
                vec4 neighborW = texture2D(tSelectionMask, vUv - vec2(texelSize.x, 0.0));

                // If neighbor color is different, this is an edge
                if (distance(ownMaskColor, neighborN) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborS) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborE) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborW) > 0.001) isEdge = 1.0;

                if (isEdge > 0.5) {
                    gl_FragColor = vec4(uOutlineColor, 1.0); // Draw outline
                } else {
                    gl_FragColor = baseColor; // Draw base scene (inner part of selection)
                }
            }
        `
    };

    outlinePass = new THREE.ShaderPass(OutlineShader);
    outlinePass.renderToScreen = true; // Render final result to screen
    composer.addPass(outlinePass);

    // Create the render target for the selection mask
    selectionMaskTarget = new THREE.WebGLRenderTarget(pixelWidth, pixelHeight);
    outlinePass.uniforms.tSelectionMask.value = selectionMaskTarget.texture;

    // --- Global Event Listeners ---

    // Disable orbit controls while Shift is held (for box selection)
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Shift') controls.enabled = false;
    });
    document.addEventListener('keyup', (event) => {
        if (event.key === 'Shift' && !selectionHelper.isDown) controls.enabled = true;
    });

    const ambientLight = new THREE.AmbientLight(0xffffff, 2.4);
    scene.add(ambientLight);


    const mainLight = new THREE.PointLight(0xffffff, 5.0);
    mainLight.position.set(0, 1.25, 1);
    mainLight.castShadow = false;
    scene.add(mainLight);

    // --- Helpers ---
    const gridHelper = new THREE.GridHelper(20, 20);
    gridHelper.position.y = -5;
    scene.add(gridHelper);

    // --- Transform Controls (Gizmo) ---
    transformControls = new THREE.TransformControls(camera, renderer.domElement);
    scene.add(transformControls);
    // --- Monkey-patch TransformControls to "emit" attach/detach ---

    /**
     * Logic to run when an object is attached to TransformControls.
     * Shows/hides UI based on the selected object.
     */
    function _onTransformControlsAttach(attachedObject) {
        // Using the console log you provided!
        console.log("%cAttached to:", "color: cyan; font-weight: bold;", attachedObject);

        const editPlayerBtn = document.getElementById('editPlayerBtn');
        const jsonControls = document.getElementById('json-controls');

        if (!attachedObject) {
            // Nothing attached, hide all
            if (editPlayerBtn) editPlayerBtn.style.display = 'none';
            if (jsonControls) jsonControls.style.display = 'none';
            selectedPlayer = null;
            return;
        }

        // Check if the object is part of a player
        let playerRoot = attachedObject;
        while (playerRoot.parent && !playerRoot.userData.isPlayer) {
            playerRoot = playerRoot.parent;
        }

        if (playerRoot.userData.isPlayer) {
            selectedPlayer = playerRoot.userData.playerInstance;
            if (editPlayerBtn) editPlayerBtn.style.display = 'inline-block';
        } else {
            selectedPlayer = null;
            if (editPlayerBtn) editPlayerBtn.style.display = 'none';
        }

        // Check if the object is a child attachment (an item attached to another item)
        let itemToCheck = attachedObject;
        // Traverse up to find the root "isItem" object
        while (itemToCheck && !itemToCheck.userData.isItem && itemToCheck.parent) {
            itemToCheck = itemToCheck.parent;
        }

        const isChildAttachment = itemToCheck &&
            itemToCheck.userData.isItem &&
            itemToCheck.parent &&
            itemToCheck.parent.userData.isItem &&
            !itemToCheck.parent.userData.isPlayer; // Exclude items attached directly to player

        // Show the toggle button only for child attachments
        if (jsonControls) {
            jsonControls.style.display = isChildAttachment ? 'block' : 'none';
        }
    }

    /**
     * Logic to run when an object is detached from TransformControls.
     * Hides all contextual UI.
     */
    function _onTransformControlsDetach(objectBeingDetached) {
        console.log("%cDetached from:", "color: orange; font-weight: bold;", objectBeingDetached);
        selectedPlayer = null;
        const editPlayerBtn = document.getElementById('editPlayerBtn');
        const jsonControls = document.getElementById('json-controls');

        if (editPlayerBtn) editPlayerBtn.style.display = 'none';
        if (jsonControls) jsonControls.style.display = 'none';
    }

    // Wrap the original .attach() function
    const originalAttach = transformControls.attach.bind(transformControls);
    transformControls.attach = function (object) {
        // Run our logic *before* attaching, in case the object is null
        // (which is valid and acts like a detach)
        if (object) {
            _onTransformControlsAttach(object); // Call our new "event handler"
        } else {
            _onTransformControlsDetach(this.object); // Call detach logic if attaching null
        }
        originalAttach(object);
    };

    // Wrap the original .detach() function
    const originalDetach = transformControls.detach.bind(transformControls);
    transformControls.detach = function () {
        const objectBeingDetached = this.object; // Get object *before* it's detached
        originalDetach();
        _onTransformControlsDetach(objectBeingDetached); // Call our new "event handler"
    };

    // --- End of patch ---

    // Enforce uniform scaling
    transformControls.addEventListener('objectChange', () => {
        if (transformControls.getMode() === 'scale') {
            const obj = transformControls.object;
            if (!obj) return;

            const axis = transformControls.axis; // Which handle is being dragged
            if (axis) {
                // Get the scale value from the axis being dragged
                let s;
                switch (axis) {
                    case 'X': s = obj.scale.x; break;
                    case 'Y': s = obj.scale.y; break;
                    case 'Z': s = obj.scale.z; break;
                    default: s = (obj.scale.x + obj.scale.y + obj.scale.z) / 3; // Center handle
                }
                // Apply that scale to all axes
                obj.scale.set(s, s, s);
            }
        }
    });

    // --- Selection System ---
    selectionBox = new SelectionBox(camera, scene);
    selectionHelper = new SelectionHelper(renderer, 'selection-box');

    // --- UI Buttons ---
    const editPlayerBtn = document.getElementById('editPlayerBtn');
    const jsonControls = document.getElementById('json-controls'); // <-- NEW
    // --- Transform Controls Event Listeners ---
    /**
         * Fired when dragging starts/stops.
         * Disables orbit controls during drag.
         * Saves new attachment transforms on drag end.
         *//**
    * Fired when dragging starts/stops.
    * Disables orbit controls during drag.
    * Saves new attachment transforms on drag end.
    */
    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value; // Disable orbit controls while dragging

        // If dragging just finished
        if (event.value === false) {
            const childModel = transformControls.object;
            if (!childModel) return;

            const parentModel = childModel.parent;

            // Check if this is a valid attachment we can save
            if (
                !parentModel ||
                !childModel.userData.isItem ||
                !parentModel.userData.isItem ||
                parentModel.userData.isPlayer || // Don't save overrides for player body
                parentModel === scene ||
                parentModel === multiSelectGroup
            ) {
                return;
            }

            const radToDeg = THREE.MathUtils.radToDeg;

            // Create new transform data from the object's local properties
            childModel.rotation.order = 'YXZ'; // Ensure correct rotation order
            const newOverride = {
                position: childModel.position.toArray().map(v => parseFloat(v.toFixed(6))),
                rotation: [
                    radToDeg(childModel.rotation.y), // Y (Yaw)
                    radToDeg(childModel.rotation.x), // X (Pitch)
                    radToDeg(childModel.rotation.z)  // Z (Roll)
                ].map(v => parseFloat(v.toFixed(3))),
                scale: parseFloat(childModel.scale.x.toFixed(4)) // Assumes uniform scale
            };

            // Save the override based on the current attachment mode
            if (window.attachmentMode === 'child') {
                // --- Save as CHILD override ---
                const childName = childModel.name;
                const parentName = parentModel.name;
                const childConfig = window.shopItems[childName];

                if (childConfig && parentName) {
                    if (!childConfig.attachment_point_overrides) {
                        childConfig.attachment_point_overrides = {};
                    }
                    childConfig.attachment_point_overrides[parentName] = newOverride;
                    console.log(`Saved CHILD override for ${childName} on ${parentName}:`, newOverride);

                    // --- Targeted cache invalidation ---
                    previewCache.delete(`${childName}_child`);
                    previewCache.delete(`${childName}_parent`);
                    previewCache.delete(`${parentName}_child`);
                    previewCache.delete(`${parentName}_parent`);
                    console.log(`Invalidated caches for ${childName} and ${parentName}`);
                }
            } else {
                // --- Save as PARENT default ---
                const parentName = parentModel.name;
                const parentConfig = window.shopItems[parentName];
                const fullSlotPath = childModel.userData.slotPath; // e.g., "body/badge/left"

                if (!parentConfig || !parentConfig.type) {
                    console.warn("Parent config or type missing, cannot save attachment point.");
                    return;
                }
                const parentType = parentConfig.type; // e.g., "body"

                // --- MODIFICATION: Check if this is a default model ---
                // A default model is one where its name is the same as its type
                // (e.g., name: "head", type: "head")
                const isDefaultModel = parentName === parentType;
                // --- END MODIFICATION ---

                if (parentConfig && fullSlotPath) {

                    let playerInstance = null;
                    let curr = parentModel;
                    while (curr) {
                        if (curr.userData?.isPlayer) {
                            playerInstance = curr.userData.playerInstance;
                            break;
                        }
                        curr = curr.parent;
                    }

                    if (isDefaultModel) {
                        // --- SAVE TO GLOBAL FALLBACK ---
                        if (window.globalModelFactory && window.globalModelFactory.globalFallbackAnchors) {
                            window.globalModelFactory.globalFallbackAnchors[fullSlotPath] = newOverride;
                            console.log(`Saved GLOBAL FALLBACK for ${fullSlotPath}:`, newOverride);

                            // Invalidate caches for all items related to this global change
                            const affectedParentType = parentType;
                            const affectedChildType = fullSlotPath;
                            console.log(`Invalidating all caches related to parent type ${affectedParentType} and child type ${affectedChildType}`);
                            for (const [itemName, config] of Object.entries(window.shopItems)) {
                                if (config.type === affectedParentType || config.type === affectedChildType) {
                                    previewCache.delete(`${itemName}_child`);
                                    previewCache.delete(`${itemName}_parent`);
                                }
                            }

                        } else {
                            console.warn("window.globalModelFactory not found, cannot save global fallback.");
                        }

                    } else {
                        // --- SAVE TO ITEM'S attachment_points (Original Logic) ---
                        let relativePath = fullSlotPath.startsWith(parentType + '/')
                            ? fullSlotPath.substring(parentType.length + 1)
                            : fullSlotPath;

                        if (!parentConfig.attachment_points) parentConfig.attachment_points = {};

                        parentConfig.attachment_points[relativePath] = newOverride;
                        console.log(`Saved PARENT attachment default for ${parentName} at ${relativePath}:`, newOverride);

                        // Invalidate caches for this specific parent and all children of the affected type
                        previewCache.delete(`${parentName}_child`);
                        previewCache.delete(`${parentName}_parent`);
                        const affectedChildType = fullSlotPath;
                        for (const [itemName, config] of Object.entries(window.shopItems)) {
                            if (config.type === affectedChildType) {
                                previewCache.delete(`${itemName}_child`);
                                previewCache.delete(`${itemName}_parent`);
                            }
                        }
                    }

                    // Refresh parent model in main scene (applies to both save types)
                    if (playerInstance) {
                        console.log("Refreshing parent model in main scene:", parentModel.name);
                        playerInstance.refreshModel(parentModel);
                    }
                }
            }

            // Refresh JSON editor
            if (window.updateJsonEditorContent && selectedObjectsForOutline) {
                window.updateJsonEditorContent(selectedObjectsForOutline);
            }

            // Refresh attachment preview bar
            // This will now miss the *specific* caches we deleted
            // and only regenerate those, loading others from cache.
            if (window.updateAttachmentPreview) {
                window.updateAttachmentPreview(childModel);
            }
        }
    });
    // Handle window resizing
    window.addEventListener('resize', onWindowResize, false);


    // --- Attachment Preview Bar Setup ---
    const previewBar = document.getElementById('ae-preview-bar');
    if (previewBar) {
        previewGrid = new ModelGridComponent(previewBar, {
            itemSize: 100,
            gap: 10,
        });
        console.log('Attachment preview grid initialized.');
    } else {
        console.warn('Could not find #ae-preview-bar element.');
    }

   const horizontalScroller = document.getElementById('ae-preview-bar');
    horizontalScroller.addEventListener('wheel', (event) => {
        event.preventDefault();

        // 1. If the device supports horizontal scrolling (Trackpad / Shift+Wheel)
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            horizontalScroller.scrollBy({
                left: event.deltaX,
                behavior: 'auto' // 'auto' feels much more responsive for trackpads than 'smooth'
            });
        } 
        // 2. Otherwise, treat vertical scroll as horizontal (Mouse Wheel)
        else {
            horizontalScroller.scrollBy({
                left: event.deltaY * 4, // Multiply to speed up mouse wheel
                behavior: 'auto'
            });
        }
    });

    // Initialize the selection listeners (see selection-stuff.js)
    initializeSelection();

    // Start the render loop
    animate();
}

/**
 * Handles window resize events.
 * Updates camera aspect, renderer size, and composer size.
 */
function onWindowResize() {
    const { width, height, pixelWidth, pixelHeight, dpr } = getCanvasSize();

    // Update camera
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Update renderer and composer
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);

    // Update render targets
    selectionMaskTarget.setSize(pixelWidth, pixelHeight);
    outlinePass.uniforms.uResolution.value.set(pixelWidth, pixelHeight);
}


const originalMaterials = new Map();

/**
 * The main animation/render loop.
 */
function animate() {
    requestAnimationFrame(animate);
    controls.update(); // Update orbit controls

    const objectsToOutline = selectedObjectsForOutline.length ? selectedObjectsForOutline : [];

    // --- Render Selection Mask ---
    if (objectsToOutline.length > 0) {
        // Get all UUIDs of all descendants of selected objects
        const selectedUUIDs = new Set();
        objectsToOutline.forEach(root => root.traverse(ch => selectedUUIDs.add(ch.uuid)));

        const originalBackground = scene.background;
        scene.background = null; // Use clear background for mask

        // Hide helpers (gizmo, grid, etc.)
        const madeInvisible = [];
        const hideForMask = (o) => {
            if (!o) return;
            o.traverse(ch => {
                if (ch.visible && (
                    ch === transformControls ||
                    ch.isGridHelper || ch.isAxesHelper ||
                    ch.isLight || ch.isCamera ||
                    ch.userData?.ignoreInMask === true
                )) {
                    madeInvisible.push(ch);
                    ch.visible = false;
                }
            });
        };
        hideForMask(transformControls);

        // Temporarily replace materials
        const hiddenNonMeshes = [];
        scene.traverse(child => {
            if (child.isMesh) {
                originalMaterials.set(child, child.material);
                // Render selected objects as white, others as black
                child.material = selectedUUIDs.has(child.uuid)
                    ? selectionMaterial
                    : blackMaterial;
            } else if (child.isLine || child.isLineSegments || child.isPoints) {
                // Hide lines/points as they don't render well in the mask
                if (child.visible) {
                    hiddenNonMeshes.push(child);
                    child.visible = false;
                }
            }
        });

        // Render the mask to the selectionMaskTarget
        renderer.setRenderTarget(selectionMaskTarget);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(null); // Reset render target

        // --- Restore Scene ---
        scene.background = originalBackground;

        // Restore original materials
        scene.traverse(child => {
            if (originalMaterials.has(child)) {
                child.material = originalMaterials.get(child);
            }
        });
        originalMaterials.clear();

        // Restore visibility of hidden objects
        hiddenNonMeshes.forEach(o => (o.visible = true));
        madeInvisible.forEach(o => (o.visible = true));

    } else {
        // No selection, just clear the mask
        renderer.setRenderTarget(selectionMaskTarget);
        renderer.clear();
        renderer.setRenderTarget(null);
    }

    // --- Render Final Scene ---
    // The composer will now run:
    // 1. RenderPass: Renders scene to composer
    // 2. OutlinePass: Reads scene (tDiffuse) and mask (tSelectionMask),
    //    and renders the final outlined image to the screen.
    composer.render();
}

/**
 * Spawns the default player model into the scene.
 */
async function spawnDefaultPlayer() {
    const defaultConfig = {
        initialItems: {},
        colors: {
            primary: new THREE.Color(0x00ff00),
            secondary: new THREE.Color(0xff0000)
        },
        userInput: "DefaultPlayer"
    };

    // --- MODIFICATION: Pass window.globalModelFactory ---
    const player = new Player(scene, window.globalModelFactory, defaultConfig);
    // --- END MODIFICATION ---

    await player.ready; // Wait for player model to be loaded

    selectedPlayer = player;
    console.log("✅ Default player loaded into scene", player);
}

/**
 * Creates a special preview cell representing an "Empty" or "Unequip" state.
 * Loads the parent model but attaches NO child to it.
 */
async function createUnequipPreviewCell(parentItemName, parentItemType, childItemType, colors) {
    try {
        // Create the parent model only
        const parentAsset = await window.globalModelFactory.create({
            itemName: parentItemName,
            itemType: parentItemType,
            colors: colors
        });
        const parentModel = parentAsset.modelGroup;

        // We do NOT attach a child. This visualizes the "Empty" state.

        return {
            model: parentModel,
            name: "Empty", // <--- CHANGED FROM "Unequip" to "Empty"
            parent: { name: parentItemName, type: parentItemType },
            child: { name: null, type: childItemType } // name: null signals an unequip action
        };
    } catch (error) {
        console.error("Failed to create unequip preview cell", error);
        return { model: null, name: "Error" };
    }
}

/**
 * Creates a single preview cell model showing a parent-child combination.
 * @param {string} parentItemName - The item name (ID) of the parent model.
 * @param {string} parentItemType - The item type (e.g., "head") of the parent.
 * @param {string} childItemName - The item name (ID) of the child model.
 * @param {string} childItemType - The item type (e.g., "head/hat").
 * @param {object} colors - The primary/secondary colors to use.
 * @param {boolean} isParentSelected - True if the *user's original selection* was a parent item.
 * @returns {object} { model, name, parent, child }
 */
async function createPreviewCell(parentItemName, parentItemType, childItemName, childItemType, colors, isParentSelected) {
    try {
        // Create parent model
        const parentAsset = await window.globalModelFactory.create({
            itemName: parentItemName,
            itemType: parentItemType,
            colors: colors
        });
        const parentModel = parentAsset.modelGroup;

        // Create child asset (we'll use/clone this)
        const childAsset = await window.globalModelFactory.create({
            itemName: childItemName,
            itemType: childItemType,
            colors: colors
        });

        const childConfig = window.shopItems[childItemName] || {};
        const parentConfig = window.shopItems[parentItemName] || {};
        const parentConfigWithId = { ...parentConfig, name: parentItemName };

        // --- MODIFICATION: Check for dual-slot base types ---
        // Read from global factory's Set
        if (window.globalModelFactory.dualSlotBaseTypes.has(childItemType)) {
            // --- DUAL ITEM LOGIC: Attach both Left and Right ---

            // 1. Create and attach Left Item
            const childModelLeft = childAsset.modelGroup; // Use the original
            const slotPathLeft = `${childItemType}/left`;
            const transformLeft = window.MeshUtils.getAttachmentTransform(
                childConfig,
                parentModel,
                slotPathLeft,
                parentConfigWithId,
                window.globalModelFactory.globalFallbackAnchors
            );
            window.MeshUtils.applyTransform(childModelLeft, transformLeft);
            parentModel.add(childModelLeft);

            // 2. Create and attach Right Item
            const childModelRight = childAsset.modelGroup.clone(); // Clone for the second
            const slotPathRight = `${childItemType}/right`;
            const transformRight = window.MeshUtils.getAttachmentTransform(
                childConfig,
                parentModel,
                slotPathRight,
                parentConfigWithId,
                window.globalModelFactory.globalFallbackAnchors
            );
            window.MeshUtils.applyTransform(childModelRight, transformRight);
            parentModel.add(childModelRight);

        } else {
            // --- ORIGINAL SINGLE ITEM LOGIC ---
            const childModel = childAsset.modelGroup;

            // Determine the slot path for attachment
            const typeParts = childItemType.split('/');
            let slotPath;
            if (childItemType.startsWith('grapple/hook/')) {
                // This will be 'grapple/hook/left' or 'right', which is NOT
                // in dualSlotBaseTypes, so this logic is correct.
                const side = typeParts.pop();
                slotPath = `rope/${side}/end`;
            } else {
                const parentType = typeParts[0];
                const sub = typeParts.slice(1).join('/');
                slotPath = `${parentType}/${sub}`;
                if (childConfig.attachment_point) {
                    // Use explicit attachment point from child config if available
                    slotPath = `${parentType}/${typeParts[1]}/${childConfig.attachment_point}`;
                }
            }

            // Get the final attachment transform
            const finalTransform = window.MeshUtils.getAttachmentTransform(
                childConfig,
                parentModel,
                slotPath,
                parentConfigWithId,
                window.globalModelFactory.globalFallbackAnchors
            );

            // Apply transform and attach child to parent
            window.MeshUtils.applyTransform(childModel, finalTransform);
            parentModel.add(childModel);
        }
        // --- END MODIFICATION ---

        // Determine the name for the preview cell
        const relevantName = isParentSelected ? childItemName : parentItemName;
        const cellName = relevantName.replace(/_/g, ' ').split(' ').pop();

        return {
            model: parentModel,
            name: cellName || "Item",
            parent: { name: parentItemName, type: parentItemType },
            child: { name: childItemName, type: childItemType }
        };

    } catch (error) {
        console.error("Failed to create preview cell:", { parentItemName, childItemName }, error);
        return { model: null, name: "Error" };
    }
}
/**
 * Generates an array of promises for all possible CHILD previews for a given parent.
 * @param {THREE.Object3D} selectedParent - The selected parent object.
 * @param {object} parentConfig - The config for the parent item.
 * @param {object} colors - Colors to use for preview models.
 * @param {string | null} childTypeFilter - [MODIFIED] If provided, only show children of this exact type.
 * @returns {Promise[]} Array of promises, each resolving to a preview cell.
 */
function generateChildPreviews(selectedParent, parentConfig, colors, childTypeFilter = null) { // <-- MODIFIED
    const previewPromises = [];
    const parentItemType = parentConfig.type; // e.g., "head"
    const childPrefix = `${parentItemType}/`; // e.g., "head/"
    const isParentSelected = true;

    // Find all items in shop that are children of this parent type
    for (const [itemName, config] of Object.entries(window.shopItems)) {

        // --- MODIFIED: Added childTypeFilter check ---
        const typeMatchesPrefix = config.type && config.type.startsWith(childPrefix);
        const typeMatchesFilter = !childTypeFilter || config.type === childTypeFilter;

        if (typeMatchesPrefix && typeMatchesFilter) {
            // --- END MODIFICATION ---
            previewPromises.push(
                createPreviewCell(
                    selectedParent.name,
                    parentItemType,
                    itemName,            // Child item name
                    config.type,         // Child item type
                    colors,
                    isParentSelected
                )
            );
        }
    }
    return previewPromises;
}
/**
 * Generates an array of promises for all possible PARENT previews for a given child.
 * @param {THREE.Object3D} selectedChild - The selected child object.
 * @param {object} childConfig - The config for the child item.
 * @param {object} colors - Colors to use for preview models.
 * @returns {Promise[]} Array of promises, each resolving to a preview cell.
 */
function generateParentPreviews(selectedChild, childConfig, colors) {
    const previewPromises = [];
    const selectedItemType = childConfig.type; // e.g., "head/hat"
    const parentType = selectedItemType.split('/')[0]; // e.g., "head"
    const isParentSelected = false;

    // Find all items in shop that are of the parent's type
    for (const [itemName, config] of Object.entries(window.shopItems)) {
        if (config.type === parentType) {
            previewPromises.push(
                createPreviewCell(
                    itemName,             // Parent item name
                    config.type,          // Parent item type
                    selectedChild.name,
                    selectedItemType,
                    colors,
                    isParentSelected
                )
            );
        }
    }
    return previewPromises;
}

/**
 * Creates the click handler for a preview grid item.
 * This handler equips the new item to the currently selected player.
 * @param {object} data - The model data payload (parent, child, name, model)
 * @param {THREE.Object3D} selectedObject - The object that was selected to generate this preview.
 */
async function createPreviewClickHandler(data, selectedObject) {
    console.log("Clicked preview:", data.name);

    // Detach Gizmo immediately to prevent crashes
    if (transformControls.object) {
        transformControls.detach();
    }

    const itemConfig = selectedObject.userData.config || window.shopItems[selectedObject.name];
    if (!itemConfig) return;
    const selectedItemType = itemConfig.type;

    // Find the player to update
    let playerToUpdate = selectedPlayer;
    if (!playerToUpdate && selectedObject) {
        let curr = selectedObject;
        while (curr) {
            if (curr.userData.isPlayer && curr.userData.playerInstance) {
                playerToUpdate = curr.userData.playerInstance;
                break;
            }
            curr = curr.parent;
        }
    }
    if (!playerToUpdate) {
        console.warn("No player selected to equip item to.");
        return;
    }

    let newItemToSelect;

    // --- CASE 1: Handle "Empty" / "Unequip" Action (name is null) ---
    if (data.child && data.child.name === null) {
        console.log(`Unequipping child type: ${data.child.type}`);

        // --- NEW: Check for wildcard unequip (e.g., "head/*") ---
        if (data.child.type && data.child.type.endsWith('/*')) {
            const prefix = data.child.type.slice(0, -2); // Remove "/*"
            // Find all active models that are children of this parent prefix
            // e.g. prefix "head" -> matches "head/hat", "head/glasses"
            // But NOT "head" itself (if it exists in activeModels as "head")
            // We use the slash check to ensure we only get children.
            const keysToRemove = Object.keys(playerToUpdate.activeModels).filter(k => k.startsWith(prefix + '/'));
            
            console.log("Wildcard unequip keys:", keysToRemove);
            await Promise.all(keysToRemove.map(k => playerToUpdate.unequipItem(k)));
        
        } else {
            // Handle dual-slot items (unequip both if needed)
            const typeParts = data.child.type.split('/');
            // If it's something like "body/badge/left", get "body/badge"
            // If it's "head/hat", this check is safe
            const possibleBase = typeParts.slice(0, -1).join('/');

            if (window.globalModelFactory.dualSlotBaseTypes.has(possibleBase)) {
                // It's a dual item (like badge left/right), unequip both sides
                await Promise.all([
                    playerToUpdate.unequipItem(`${possibleBase}/left`),
                    playerToUpdate.unequipItem(`${possibleBase}/right`)
                ]);
            } else {
                // Standard unequip
                await playerToUpdate.unequipItem(data.child.type);
            }
        }

        // After unequipping, select the Parent model (e.g. the Head)
        newItemToSelect = playerToUpdate.activeModels[data.parent.type];

        // --- CASE 2: Standard Equip Action ---
    } else {
        const selectedItemType = itemConfig.type;
        const isSwitchingParent = selectedItemType.includes('/');
        const isSwitchingChild = !selectedItemType.includes('/');

        if (isSwitchingParent && window.attachmentMode === 'child') {
            // Switching PARENT
            console.log(`Switching parent to: ${data.parent.name}`);
            await playerToUpdate.equipItem(data.parent.name, data.parent.type);

            // Re-find the child item on the player
            newItemToSelect = playerToUpdate.activeModels[selectedItemType];

        } else if (isSwitchingChild || (isSwitchingParent && window.attachmentMode === 'parent')) {
            // Switching CHILD
            console.log(`Equipping child: ${data.child.name}`);

            const childBaseType = data.child.type;

            if (window.globalModelFactory.dualSlotBaseTypes.has(childBaseType)) {
                await Promise.all([
                    playerToUpdate.equipItem(data.child.name, `${childBaseType}/left`),
                    playerToUpdate.equipItem(data.child.name, `${childBaseType}/right`)
                ]);
                newItemToSelect = playerToUpdate.activeModels[`${childBaseType}/left`];
            } else {
                await playerToUpdate.equipItem(data.child.name, data.child.type);
                newItemToSelect = playerToUpdate.activeModels[data.child.type];
            }
        }
    }


    // Update selection to the newly relevant item (or Parent if unequipped)
    if (newItemToSelect) {

        // Preserve selection logic (keep parent selected if it was the original selection)
        let objectToHighlight = newItemToSelect;
        let isOriginalStillValid = false;
        if (selectedObject && selectedObject.parent) {
            let curr = selectedObject;
            while (curr) {
                if (curr === scene) {
                    isOriginalStillValid = true;
                    break;
                }
                curr = curr.parent;
            }
        }

        // If we unequipped, we likely WANT to highlight the parent (newItemToSelect),
        // so we don't need to force preserve "selectedObject" if that object was the child we just removed.
        // However, if we were already on the Parent, isOriginalStillValid is true, so we stay on Parent.
        if (isOriginalStillValid) {
            objectToHighlight = selectedObject;
        }

        transformControls.attach(objectToHighlight);
        selectedObjectsForOutline = [objectToHighlight];

        // Update UI
        selectedPlayer = playerToUpdate;
        const editPlayerBtn = document.getElementById('editPlayerBtn');
        if (editPlayerBtn) editPlayerBtn.style.display = 'inline-block';

        const jsonControls = document.getElementById('json-controls');
        if (jsonControls) {
            let isChild = false;
            let check = objectToHighlight;
            if (check.userData.isItem && check.parent && check.parent.userData.isItem && !check.parent.userData.isPlayer) {
                isChild = true;
            }
            jsonControls.style.display = isChild ? 'block' : 'none';
        }

        window.updateAttachmentPreview(objectToHighlight);
        if (window.updateJsonEditorContent) {
            window.updateJsonEditorContent(selectedObjectsForOutline);
        }
    } else {
        selectedObjectsForOutline = [];
        window.updateAttachmentPreview(null);
        if (window.updateJsonEditorContent) {
            window.updateJsonEditorContent([]);
        }
    }
}

/**
 * Updates the attachment preview bar based on the selected object.
 * Uses caching to avoid regenerating models.
 * @param {THREE.Object3D} selectedObject - The currently selected item.
 */
async function updateAttachmentPreview(selectedObject) {
    if (!previewGrid || !window.globalModelFactory) return;

    if (!selectedObject || !selectedObject.userData.isItem) {
        previewGrid.clearAll();
        previewGrid.showEmptyState();
        return;
    }

    // --- FIX: Capture scroll from the CONTAINER (not the inner grid) ---
    // The container is the element that actually has the scrollbar.
    const currentScroll = previewGrid.container.scrollLeft;

    // --- Caching ---
    const cacheKey = `${selectedObject.name}_${window.attachmentMode}`;
    if (previewCache.has(cacheKey)) {
        console.log(`♻️ Loading previews from cache for: ${cacheKey}`);
        previewGrid.clearAll();
        const cachedModels = previewCache.get(cacheKey);

        if (cachedModels.length === 0) {
            previewGrid.grid.innerHTML = '<div class="empty-state">No compatible items found.</div>';
        } else {
            cachedModels.forEach(data => {
                previewGrid.addModel(data.model, data.name, {
                    onClick: () => createPreviewClickHandler(data, selectedObject)
                });
            });
        }
        
        // --- FIX: Restore scroll position (Cache Hit) ---
        requestAnimationFrame(() => {
            if (previewGrid && previewGrid.container) {
                previewGrid.container.scrollLeft = currentScroll;
            }
        });
        return;
    }

    console.log(`⏳ Generating new previews for: ${cacheKey}`);

    const itemConfig = selectedObject.userData.config || window.shopItems[selectedObject.name];
    if (!itemConfig || !itemConfig.type) return;

    const selectedItemType = itemConfig.type;
    const colors = {
        primary: new THREE.Color(0x999999),
        secondary: new THREE.Color(0x666666)
    };

    // Note: This clears the grid DOM, which is why we captured scroll at the top.
    previewGrid.showLoadingState();
    
    let previewPromises = [];

    if (selectedItemType.includes('/')) {
        // --- Selected object is a CHILD item (e.g., "head/hat") ---
        if (window.attachmentMode === 'child') {
            // "CHILD" mode: Show PARENT options (e.g. swap Head)
            previewPromises = generateParentPreviews(selectedObject, itemConfig, colors);
            
            if (selectedObject.parent && selectedObject.parent.userData.isItem) {
                 previewPromises.push(
                    createUnequipPreviewCell(
                        selectedObject.parent.name, 
                        selectedObject.parent.userData.config.type, 
                        selectedItemType, 
                        colors
                    )
                );
            }

        } else {
            // "PARENT" mode: Show CHILD options (siblings of current child)
            const parentObject = selectedObject.parent;
            if (parentObject && parentObject.userData.isItem && !parentObject.userData.isPlayer) {
                const parentConfig = parentObject.userData.config || window.shopItems[parentObject.name];
                if (parentConfig) {
                    const childTypeFilter = selectedItemType;

                    // 1. Generate normal item previews
                    previewPromises = generateChildPreviews(parentObject, parentConfig, colors, childTypeFilter);

                    // 2. Add Empty option (Unequip this child slot)
                    previewPromises.push(
                        createUnequipPreviewCell(parentObject.name, parentConfig.type, childTypeFilter, colors)
                    );
                }
            }
        }
    } else {
        // --- Selected object is a PARENT item (e.g., "head") ---
        // Show all children options
        previewPromises = generateChildPreviews(selectedObject, itemConfig, colors);

        // Add "Empty" option to unequip ALL children from this parent
        previewPromises.push(
             createUnequipPreviewCell(selectedObject.name, itemConfig.type, itemConfig.type + "/*", colors)
        );
    }

    try {
        const models = await Promise.all(previewPromises);
        previewGrid.clearAll();

        let count = 0;
        models.reverse(); // Show items in a consistent order

        const modelsToCache = [];
        models.forEach(data => {
            if (data.model) {
                const modelForCache = data.model.clone();
                modelsToCache.push({ ...data, model: modelForCache });

                previewGrid.addModel(data.model, data.name, {
                    onClick: () => createPreviewClickHandler(data, selectedObject)
                });
                count++;
            }
        });
        previewCache.set(cacheKey, modelsToCache);

        if (count === 0) {
            previewGrid.grid.innerHTML = '<div class="empty-state">No compatible items found.</div>';
        } else {
            // --- FIX: Restore scroll position (New Generation) ---
            // Double-RAF ensures the DOM has fully reflowed and painted before we scroll
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (previewGrid && previewGrid.container) {
                        previewGrid.container.scrollLeft = currentScroll;
                    }
                });
            });
        }
    } catch (error) {
        console.error("Error generating previews:", error);
        previewGrid.grid.innerHTML = '<div class="empty-state">Error loading previews.</div>';
    }
}
window.updateAttachmentPreview = updateAttachmentPreview;


// --- COSMETIC UPLOADER (BATCH SUPPORT) ---

let uploadQueue = [];
let currentFileIndex = 0;

/**
 * Opens the cosmetic uploader popup and resets it.
 */
function openCosmeticUploader() {
    const overlay = document.getElementById('attachmentOverlay');
    overlay.style.display = 'flex';
    
    // Reset State
    uploadQueue = [];
    currentFileIndex = 0;
    
    // Reset UI
    document.getElementById('uploadQueueStatus').style.display = 'none';
    document.getElementById('nextButton').style.display = 'none';
    document.getElementById('nextButton').textContent = 'Next Item';
    document.getElementById('uploadButton').style.display = 'inline-block';
    document.getElementById('uploadButton').textContent = 'Select Files...';
    document.getElementById('uploadButton').style.backgroundColor = '#3b82f6';
    document.getElementById('attachmentTypeSelect').value = "";
    document.getElementById('itemKey').value = "";
}

function closeCosmeticUploader() {
    document.getElementById('attachmentOverlay').style.display = 'none';
    uploadQueue = [];
    currentFileIndex = 0;
}

/**
 * Updates the auto-generated Item Key based on type, filename, and date.
 * Format: type_filename_year (e.g., head_hat_cool_hat_2025)
 */
window.updateItemKey = function() {
    if (uploadQueue.length === 0) return;

    const file = uploadQueue[currentFileIndex];
    const typeSelect = document.getElementById('attachmentTypeSelect');
    const type = typeSelect.value;
    const keyInput = document.getElementById('itemKey');

    if (!type || !file) return;

    // 1. Clean Type: "head/hat" -> "head_hat"
    const cleanType = type.replace(/\//g, '_');

    // 2. Clean Filename: "My Cool Hat.sgm" -> "my_cool_hat"
    let cleanName = file.name.split('.')[0]
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_') // Replace non-alphanumeric with _
        .replace(/_+/g, '_');       // Remove duplicate underscores

    // 3. Year
    const year = new Date().getFullYear();

    // 4. Combine
    keyInput.value = `${cleanType}_${cleanName}_${year}`;
}

/**
 * Handles the file selection (Multiple files supported).
 */
function handleUploadFilesSelect(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    uploadQueue = files;
    currentFileIndex = 0;

    // UI Updates
    document.getElementById('uploadButton').style.display = 'none'; // Hide select button
    document.getElementById('nextButton').style.display = 'inline-block'; // Show Next/Done
    
    document.getElementById('uploadQueueStatus').style.display = 'block';
    
    // Start processing first file
    loadCurrentFileInQueue();
}

/**
 * Loads the current file from the queue into the UI for configuration.
 */
function loadCurrentFileInQueue() {
    if (currentFileIndex >= uploadQueue.length) {
        // Should not happen, but safe check
        closeCosmeticUploader();
        return;
    }

    const file = uploadQueue[currentFileIndex];
    
    // Update Progress Text
    document.getElementById('queueCurrent').textContent = currentFileIndex + 1;
    document.getElementById('queueTotal').textContent = uploadQueue.length;

    // Update Button Text (Next vs Done)
    const nextBtn = document.getElementById('nextButton');
    if (currentFileIndex === uploadQueue.length - 1) {
        nextBtn.textContent = "Finish";
        nextBtn.className = "btn btn-success";
    } else {
        nextBtn.textContent = "Next Item";
        nextBtn.className = "btn btn-primary";
    }

    // Try to auto-guess type? (Optional, maybe skip for now and force user select)
    // Just trigger key update in case type is already selected
    updateItemKey();
}

/**
 * Saves the current item and moves to the next one.
 */
async function processCurrentAndNext() {
    const file = uploadQueue[currentFileIndex];
    const type = document.getElementById('attachmentTypeSelect').value;
    const itemKey = document.getElementById('itemKey').value.trim();

    // Validation
    if (!type) {
        alert("Please select an Item Type.");
        return;
    }
    if (!itemKey) {
        alert("Item Key is required.");
        return;
    }
    if (window.shopItems[itemKey]) {
        if (!confirm(`Item Key "${itemKey}" already exists. Overwrite?`)) {
            return;
        }
    }

    // Register Item
    const fileUrl = URL.createObjectURL(file);
    const newItemConfig = {
        title: itemKey, // Simple title
        type: type,
        file: fileUrl,
        materials: [
            { type: "default_primary_color" },
            { type: "default_secondary_color" }
        ],
        preview_rotation: [0, 0, 0] // Default
    };

    window.shopItems[itemKey] = newItemConfig;
    console.log(`✅ Registered: ${itemKey}`);

    // Move Queue
    currentFileIndex++;

    if (currentFileIndex < uploadQueue.length) {
        // Load next
        loadCurrentFileInQueue();
        
        // Reset Inputs for next
        // (Optional: Keep type selected if user is uploading 10 hats?)
        // Let's keep the type selected for convenience, just update the key.
        updateItemKey(); 
    } else {
        // Finished
        previewCache.clear();
        if (typeof filterItems === 'function') filterItems();
        if (typeof filterPlayerItems === 'function') filterPlayerItems();
        
        alert(`Successfully registered ${uploadQueue.length} items!`);
        closeCosmeticUploader();
    }
}

// --- Wire up Listeners ---
try {
    const uploadBtn = document.getElementById('uploadButton');
    const modelInput = document.getElementById('modelUpload');
    const nextBtn = document.getElementById('nextButton');
    const cancelBtn = document.getElementById('cancelButton'); // Was nextButton/Done before

    if (uploadBtn) uploadBtn.onclick = () => modelInput.click();
    if (modelInput) modelInput.onchange = handleUploadFilesSelect;
    if (nextBtn) nextBtn.onclick = processCurrentAndNext;
    if (cancelBtn) cancelBtn.onclick = closeCosmeticUploader;

} catch (error) {
    console.error("Failed to wire up cosmetic uploader listeners:", error);
}

// Expose globals
window.openCosmeticUploader = openCosmeticUploader;
window.closeCosmeticUploader = closeCosmeticUploader;


// --- APP INITIALIZATION ---

/**
 * Main async function to start the application.
 * Fetches items, initializes the model factory, sets up the scene,
 * and spawns the initial player.
 */
(async () => {
    await fetchShopItems();

    // Initialize the factory that builds player models and items
    if (window.PlayerModelFactory) {
        window.globalModelFactory = new window.PlayerModelFactory(window.shopItems);
    } else {
        console.error("PlayerModelFactory not found on window!");
    }

    // Set up the 3D scene
    initScene();

    // Load the default player
    await spawnDefaultPlayer();
})();

// Catch normal JS errors
window.onerror = function (msg, url, line, col, error) {
    // FIX: Ignore the benign ResizeObserver loop error from Monaco Editor
    if (msg && msg.toString().includes("ResizeObserver loop completed")) {
        return false; // Suppress the alert and let the browser handle it silently
    }

    alert("❌ Error: " + msg + "\nLine: " + line + ":" + col);
    console.error("❌ JS Error:", msg, url, line, col, error);
};

// Catch errors inside async loaders / Promises (like glTF loader)
window.addEventListener("unhandledrejection", function (event) {
    alert("❌ Promise Error: " + event.reason);
    console.error("❌ Unhandled Promise Rejection:", event.reason);
});
// --- NEW FEATURE: Keybinds for Preview Navigation ---

let lastNavigatedIndex = -1;
/**
 * Navigation handler for the preview bar (Left/Right Arrows).
 * Cycles through the available items in the preview grid.
 */
async function handlePreviewNavigation(direction) { 
    if (!previewGrid || !selectedPlayer || !transformControls.object) return;

    const selectedObject = transformControls.object;
    const cacheKey = `${selectedObject.name}_${window.attachmentMode}`;
    const cachedData = previewCache.get(cacheKey);

    if (!cachedData || cachedData.length === 0) return;

    // 1. Capture current scroll position BEFORE the grid rebuilds
    const currentScroll = previewGrid.grid.scrollLeft;

    // Helper: Check if a specific model (parent or child) is currently equipped
    const isModelEquipped = (modelData) => {
        if (modelData.name === null) {
            const type = modelData.type;
            if (type.endsWith('/*')) {
                const prefix = type.slice(0, -2);
                return !Object.keys(selectedPlayer.activeModels).some(k => k.startsWith(prefix + '/'));
            }
            if (selectedPlayer.activeModels[type]) return false;
            if (selectedPlayer.activeModels[`${type}/left`]) return false;
            if (selectedPlayer.activeModels[`${type}/right`]) return false;
            return true;
        }

        if (selectedPlayer.activeModels[modelData.type] && 
            selectedPlayer.activeModels[modelData.type].name === modelData.name) return true;
        
        if (selectedPlayer.activeModels[`${modelData.type}/left`] && 
            selectedPlayer.activeModels[`${modelData.type}/left`].name === modelData.name) return true;
        if (selectedPlayer.activeModels[`${modelData.type}/right`] && 
            selectedPlayer.activeModels[`${modelData.type}/right`].name === modelData.name) return true;
        
        return false;
    };

    // --- FIX START: Smart Index Finding ---
    let currentIndex = -1;

    // A. Priority: Check if the last known index is still valid (Prevents looping bug)
    if (lastNavigatedIndex >= 0 && lastNavigatedIndex < cachedData.length) {
        const lastItem = cachedData[lastNavigatedIndex];
        // If the item at the last index matches our current state, trust it!
        if (isModelEquipped(lastItem.parent) && isModelEquipped(lastItem.child)) {
            currentIndex = lastNavigatedIndex;
        }
    }

    // B. Fallback: Scan from 0 if history was invalid (e.g. manual click changed state)
    if (currentIndex === -1) {
        for (let i = 0; i < cachedData.length; i++) {
            const item = cachedData[i];
            if (isModelEquipped(item.parent) && isModelEquipped(item.child)) {
                currentIndex = i;
                break; // This causes the bug without the history check above
            }
        }
    }
    // --- FIX END ---

    // Calculate next index
    let nextIndex;
    if (currentIndex === -1) {
        nextIndex = 0; 
    } else {
        nextIndex = (currentIndex + direction + cachedData.length) % cachedData.length;
    }

    // Update history for next time
    lastNavigatedIndex = nextIndex;

    const nextItemData = cachedData[nextIndex];

    // 2. Equip the new item
    await createPreviewClickHandler(nextItemData, selectedObject);

    // 3. Restore the scroll position INSTANTLY
    if (previewGrid.grid) {
        previewGrid.grid.scrollLeft = currentScroll;
    }
    
    // 4. Smooth scroll to the NEW target (offset by 10% of container width)
    setTimeout(() => {
        const item = previewGrid.gridItems[nextIndex];
        // FIX: Use .container because CSS puts 'overflow-x: scroll' on the container ID, not the grid
        const scrollContainer = previewGrid.container; 

        if (item && scrollContainer) {
            // 1. Get the item's absolute center position relative to the grid
            const itemCenter = item.offsetLeft + (item.offsetWidth / 2);
            
            // 2. Calculate offset (10% of the visible container width)
            const offset = scrollContainer.clientWidth * 0.10;

            // 3. Subtract to align item center with the 10% mark
            const targetScroll = itemCenter - offset;

            scrollContainer.scrollTo({
                left: targetScroll,
                behavior: 'smooth'
            });
        }
    }, 10);

}
window.addEventListener('keydown', (e) => {
    // Ignore if typing in an input field
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

    if (e.key.toUpperCase() === 'A') {
        e.preventDefault(); 
        handlePreviewNavigation(-1);
    } else if (e.key.toUpperCase() === 'D') {
        e.preventDefault(); 
        handlePreviewNavigation(1);
    }
});