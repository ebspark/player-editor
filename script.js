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

// --- MODIFICATION: Globals for custom type preview ---
window.previewMannequin = null; // Holds the Player instance for preview
window.tempPreviewItemName = null; // ID of the temporary item in shopItems
window.tempPreviewItemType = null; // e.g. "head/forehead_gem"
window.tempPreviewFallbackType = null; // The type string for the temp fallback
// --- END MODIFICATION ---


/**
 * Toggles the attachment editing mode between 'child' and 'parent'.
 * Updates the UI button and refreshes the JSON editor and preview bar.
 */
window.toggleAttachmentMode = function() {
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
transformControls.attach = function(object) {
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
transformControls.detach = function() {
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
            default:  s = (obj.scale.x + obj.scale.y + obj.scale.z) / 3; // Center handle
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
                    while(curr) {
                        if(curr.userData?.isPlayer) {
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

    // Add horizontal scrolling (wheel) to the preview bar
    const horizontalScroller = document.getElementById('ae-preview-bar');
    horizontalScroller.addEventListener('wheel', (event) => {
        event.preventDefault(); 
        horizontalScroller.scrollBy({
            left: event.deltaY*4, // Scroll horizontally on vertical wheel
        });
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
}/**
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
 * @returns {Promise[]} Array of promises, each resolving to a preview cell.
 */
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
    
    const itemConfig = selectedObject.userData.config || window.shopItems[selectedObject.name];
    if (!itemConfig) return; 
    const selectedItemType = itemConfig.type;
    
    // Find the player to update
    let playerToUpdate = selectedPlayer;
    if (!playerToUpdate && selectedObject) {
         let curr = selectedObject;
         while(curr) {
             if(curr.userData.isPlayer && curr.userData.playerInstance) {
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
    let newItemIsChildAttachment = false; 

    // Determine if we are switching the parent or the child
    const isSwitchingParent = selectedItemType.includes('/'); // Selected a child, switching its parent
    const isSwitchingChild = !selectedItemType.includes('/'); // Selected a parent, switching its child

    if (isSwitchingParent && window.attachmentMode === 'child') {
        // Mode: CHILD. We are switching the PARENT of the selected child.
        console.log(`Switching parent to: ${data.parent.name}`);
        await playerToUpdate.equipItem(data.parent.name, data.parent.type);
        
        // Re-find the child item on the player
        newItemToSelect = playerToUpdate.activeModels[selectedItemType];
        newItemIsChildAttachment = (newItemToSelect && newItemToSelect.parent && newItemToSelect.parent.userData.isItem);
        
    } else if (isSwitchingChild || (isSwitchingParent && window.attachmentMode === 'parent')) {
        // Mode: PARENT. We are switching the CHILD on the selected parent.
        // OR
        // We selected a parent item, so we are equipping a new CHILD.
        console.log(`Equipping child: ${data.child.name}`);

        // --- MODIFICATION: Handle dual-slot items ---
        const childBaseType = data.child.type; // e.g., "body/badge"
        
        // Read from global factory's Set
        if (window.globalModelFactory.dualSlotBaseTypes.has(childBaseType)) {
            // Equip both left and right
            await Promise.all([
                playerToUpdate.equipItem(data.child.name, `${childBaseType}/left`),
                playerToUpdate.equipItem(data.child.name, `${childBaseType}/right`)
            ]);
            
            // Select the 'left' item by default for the gizmo to attach to
            newItemToSelect = playerToUpdate.activeModels[`${childBaseType}/left`];
            
        } else {
            // Original single-item logic
            await playerToUpdate.equipItem(data.child.name, data.child.type);
            newItemToSelect = playerToUpdate.activeModels[data.child.type];
        }
        // --- END MODIFICATION ---
        
        newItemIsChildAttachment = true; // We just equipped a child
    }


    // Update selection to the newly relevant item
    if (newItemToSelect) {
        transformControls.attach(newItemToSelect);
        selectedObjectsForOutline = [newItemToSelect];
        
        // Update UI state
        selectedPlayer = playerToUpdate; 
        editPlayerBtn.style.display = 'inline-block';
const jsonControls = document.getElementById('json-controls'); // <-- NEW
    if (jsonControls) { // <-- NEW
        jsonControls.style.display = newItemIsChildAttachment ? 'block' : 'none'; // <-- NEW
    }
        // Refresh previews and JSON editor for the new selection
        window.updateAttachmentPreview(newItemToSelect);
        if (window.updateJsonEditorContent) {
            window.updateJsonEditorContent(selectedObjectsForOutline);
        }
    } else {
        console.warn("Could not find newly equipped item. Clearing selection.");
        transformControls.detach();
        selectedObjectsForOutline = [];
        window.updateAttachmentPreview(null);
        if (window.updateJsonEditorContent) {
            window.updateJsonEditorContent([]);
        }
    }
}/**
 * Updates the attachment preview bar based on the selected object.
 * Uses caching to avoid regenerating models.
 * @param {THREE.Object3D} selectedObject - The currently selected item.
 */
async function updateAttachmentPreview(selectedObject) {
    if (!previewGrid || !window.globalModelFactory) return; 
    
    // Clear preview if nothing is selected
    if (!selectedObject || !selectedObject.userData.isItem) {
        previewGrid.clearAll(); 
        previewGrid.showEmptyState(); 
        return; 
    }

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
                // Add models from cache
                previewGrid.addModel(data.model, data.name, {
                    onClick: () => createPreviewClickHandler(data, selectedObject)
                });
            });
        }
        return; // Stop here, loaded from cache
    }
    
    console.log(`⏳ Generating new previews for: ${cacheKey}`);

    const itemConfig = selectedObject.userData.config || window.shopItems[selectedObject.name];
    if (!itemConfig || !itemConfig.type) {
        console.warn("Preview: Selected item has no config or type.", selectedObject);
        return;
    }

    const selectedItemType = itemConfig.type;
    const colors = { 
        primary: new THREE.Color(0x999999), 
        secondary: new THREE.Color(0x666666) 
    }; 

    previewGrid.showLoadingState();
    let previewPromises = [];

    if (selectedItemType.includes('/')) {
        // --- Selected object is a CHILD item (e.g., "head/hat") ---
        if (window.attachmentMode === 'child') {
            // "CHILD" mode: Show PARENT options (e.g., other heads)
            previewPromises = generateParentPreviews(selectedObject, itemConfig, colors);
        } else {
            // "PARENT" mode: Show CHILD options (e.g., other hats)
            const parentObject = selectedObject.parent;
            if (parentObject && parentObject.userData.isItem && !parentObject.userData.isPlayer) {
                const parentConfig = parentObject.userData.config || window.shopItems[parentObject.name];
                if (parentConfig) {
                    
                    // --- MODIFICATION: Pass the child's type as a filter ---
                    const childTypeFilter = selectedItemType; // e.g. "head/hat"
                    previewPromises = generateChildPreviews(parentObject, parentConfig, colors, childTypeFilter);
                    // --- END MODIFICATION ---

                }
            }
        }
    } else {
        // --- Selected object is a PARENT item (e.g., "head") ---
        // Show CHILD options (e.g., hats)
        // No filter here, we want to see ALL children (hats, glasses, etc.)
        previewPromises = generateChildPreviews(selectedObject, itemConfig, colors);
    }
    
    
    try {
        // Wait for all preview models to be generated
        const models = await Promise.all(previewPromises);
        previewGrid.clearAll(); 
        
        let count = 0;
        models.reverse(); // Show items in a consistent order

        const modelsToCache = [];
        
        models.forEach(data => {
            if (data.model) {
                // Clone model for the cache
                const modelForCache = data.model.clone();
                modelsToCache.push({ ...data, model: modelForCache });
                
                // Add original model to the grid
                previewGrid.addModel(data.model, data.name, {
                    onClick: () => createPreviewClickHandler(data, selectedObject)
                });
                count++;
            }
        });

        // Save the cloned models to the cache
        previewCache.set(cacheKey, modelsToCache);

        if (count === 0) {
            previewGrid.grid.innerHTML = '<div class="empty-state">No compatible items found.</div>';
        }
    } catch (error) {
        console.error("Error generating previews:", error);
        previewGrid.grid.innerHTML = '<div class="empty-state">Error loading previews.</div>';
    }
}
window.updateAttachmentPreview = updateAttachmentPreview; 


// --- COSMETIC UPLOADER ---

/**
 * Opens the cosmetic uploader popup and resets its fields.
 */
function openCosmeticUploader() {
    const overlay = document.getElementById('attachmentOverlay');
    overlay.style.display = 'flex';

    // Reset fields to default
    // === MODIFICATION START ===
    document.getElementById('attachmentTypeInput').value = 'head/hat';
    // === MODIFICATION END ===
    document.getElementById('attachmentSide').value = 'none';
    document.getElementById('modelName').value = '';
    
    const fileInput = document.getElementById('modelUpload');
    fileInput.value = ''; // Clear file input
    // --- MODIFICATION START: Add event listener for live preview ---
    fileInput.addEventListener('change', liveUpdateCustomTypePreview);
    // --- END MODIFICATION ---
    
    const uploadButton = document.getElementById('uploadButton');
    uploadButton.textContent = 'Upload Cosmetic';
    uploadButton.style.backgroundColor = '#3b82f6'; 

    // --- MODIFICATION START: Call handler to set initial UI state ---
    handleAttachmentTypeChange();
    // --- END MODIFICATION ---
}

/**
 * Closes the cosmetic uploader popup.
 */
function closeCosmeticUploader() {
    const overlay = document.getElementById('attachmentOverlay');
    overlay.style.display = 'none';

    // --- MODIFICATION START: Remove listener and tear down preview ---
    document.getElementById('modelUpload').removeEventListener('change', liveUpdateCustomTypePreview);
    teardownCustomTypePreview();
    // --- END MODIFICATION ---
}
/**
 * Shows or hides the "Side" dropdown and the new "Custom Type Setup"
 * based on the selected attachment type.
 */
function handleAttachmentTypeChange() {
    const typeInput = document.getElementById('attachmentTypeInput');
    const type = typeInput.value.trim();
    
    const sideSelection = document.getElementById('sideSelection');
    const customTypeSetup = document.getElementById('customTypeSetup');
    const attachmentSideSelect = document.getElementById('attachmentSide');

    // --- MODIFICATION: Get the dual item selection div ---
    const dualItemSelection = document.getElementById('dualItemSelection');
    // --- END MODIFICATION ---

    // --- Side selection logic ---
    if (type === 'hand' || type === 'body/badge' || type === 'grapple/hook') {
        sideSelection.style.display = 'block';
        if (type === 'grapple/hook') {
             attachmentSideSelect.options[0].disabled = true;
             if (attachmentSideSelect.value === 'none') {
                attachmentSideSelect.value = 'left'; 
             }
        } else {
             attachmentSideSelect.options[0].disabled = false;
        }

    } else {
        sideSelection.style.display = 'none';
        attachmentSideSelect.value = 'none'; 
    }
    
    // --- New Custom Type setup logic ---
    
    let finalItemType = type;
    const side = attachmentSideSelect.value;

    if (side !== 'none') {
        if (type === 'hand') finalItemType = `hand/${side}`;
        else if (type === 'body/badge') finalItemType = `body/badge/${side}`;
        else if (type === 'grapple/hook') finalItemType = `grapple/hook/${side}`;
        else finalItemType = `${type}/${side}`; 
    }

    if (window.globalModelFactory) {
        // --- MODIFICATION: Check base type for fallbacks/defaults too ---
        // We only care if the BASE type (e.g. "body/badge") is new,
        // not the specific side (e.g. "body/badge/left").
        const isBaseDefault = window.globalModelFactory.defaults[type] !== undefined;
        const isBaseFallback = window.globalModelFactory.globalFallbackAnchors[type] !== undefined;
        // --- END MODIFICATION ---

        if (type && !isBaseDefault && !isBaseFallback) { // <-- Use base type for check
            // --- MODIFICATION START: Show custom setup AND dual item checkbox ---
            if (customTypeSetup.style.display !== 'block') {
                customTypeSetup.style.display = 'block';
                dualItemSelection.style.display = 'block'; // <-- Show dual item checkbox
                setupCustomTypePreview(); // Setup mannequin
            }
            // --- END MODIFICATION ---
        } else {
            // --- MODIFICATION START: Hide custom setup AND dual item checkbox ---
            if (customTypeSetup.style.display !== 'none') {
                customTypeSetup.style.display = 'none';
                dualItemSelection.style.display = 'none'; // <-- Hide dual item checkbox
                document.getElementById('attachmentDualItem').checked = false; // <-- Uncheck it
                teardownCustomTypePreview(); // Teardown mannequin
            }
            // --- END MODIFICATION ---
        }
    } else {
        customTypeSetup.style.display = 'none';
        dualItemSelection.style.display = 'none'; // <-- Hide if factory isn't ready
    }

    // --- MODIFICATION START: Live update preview on type change ---
    liveUpdateCustomTypePreview();
    // --- END MODIFICATION ---
}

// --- MODIFICATION START: New functions for live preview ---

/**
 * Creates and configures the preview mannequin.
 */
async function setupCustomTypePreview() {
    if (window.previewMannequin) {
        window.previewMannequin.dispose();
    }
    
    // Find the main player to get its colors
    let primary = new THREE.Color(0x999999);
    let secondary = new THREE.Color(0x666666);
    if (selectedPlayer && selectedPlayer.root && selectedPlayer.root.userData.playerInstance) {
        const colors = scene.userData[selectedPlayer.root.userData.playerInstance.userInput];
        if (colors) {
            primary = colors.primary_color;
            secondary = colors.secondary_color;
        }
    }

    // --- MODIFICATION: Pass window.globalModelFactory ---
    window.previewMannequin = new Player(scene, window.globalModelFactory, { 
        userInput: "__PREVIEW_MANNEQUIN__",
        colors: { primary, secondary }
    });
    // --- END MODIFICATION ---
    
    await window.previewMannequin.ready;
    window.previewMannequin.root.position.set(2, 0, 0); // Position off to the right
    console.log("Setup preview mannequin");
    
    liveUpdateCustomTypePreview(); // Run preview with initial values
}

/**
 * Removes the preview mannequin and cleans up temporary data.
 */
function teardownCustomTypePreview() {
    if (window.previewMannequin) {
        window.previewMannequin.dispose();
        window.previewMannequin = null;
        console.log("Tore down preview mannequin");
    }
    
    // Clean up temporary item
    if (window.tempPreviewItemName) {
        delete window.shopItems[window.tempPreviewItemName];
        window.tempPreviewItemName = null;
    }
    
    // Clean up temporary fallback
    if (window.tempPreviewFallbackType) {
        delete window.globalModelFactory.globalFallbackAnchors[window.tempPreviewFallbackType];
        window.tempPreviewFallbackType = null;
    }
}

/**
 * The main live-update function. Called on input changes.
 * Reads form, updates globals, and re-equips mannequin.
 */
async function liveUpdateCustomTypePreview() {
    // Only run if the custom setup is visible and mannequin exists
    if (document.getElementById('customTypeSetup').style.display !== 'block' || !window.previewMannequin) {
        return;
    }

    const fileInput = document.getElementById('modelUpload');
    const file = fileInput.files[0];
    
    if (!file) {
        // No file, just clean up old preview item if it exists
        if (window.tempPreviewItemName) {
            await window.previewMannequin.unequipItem(window.tempPreviewItemType);
            delete window.shopItems[window.tempPreviewItemName];
            window.tempPreviewItemName = null;
        }
        return;
    }
    
    // --- 1. Clean up previous temporary data ---
    if (window.tempPreviewItemName) {
        await window.previewMannequin.unequipItem(window.tempPreviewItemType);
        delete window.shopItems[window.tempPreviewItemName];
    }
    if (window.tempPreviewFallbackType) {
        delete window.globalModelFactory.globalFallbackAnchors[window.tempPreviewFallbackType];
    }

    // --- 2. Get current form values ---
    const attachmentTypeBase = document.getElementById('attachmentTypeInput').value.trim();
    const attachmentSide = document.getElementById('attachmentSide').value;

    let finalItemType = attachmentTypeBase;
    if (attachmentSide !== 'none') {
        if (attachmentTypeBase === 'hand') finalItemType = `hand/${attachmentSide}`;
        else if (attachmentTypeBase === 'body/badge') finalItemType = `body/badge/${attachmentSide}`;
        else if (attachmentTypeBase === 'grapple/hook') finalItemType = `grapple/hook/${attachmentSide}`;
        else finalItemType = `${attachmentTypeBase}/${attachmentSide}`;
    }
    
    if (!finalItemType) return;
    
    const parentType = finalItemType.split('/')[0];
    if (!parentType || !window.globalModelFactory.defaults[parentType]) {
        console.warn(`Cannot preview: No default item found for parent type "${parentType}"`);
        return;
    }

    // --- 3. Get transform from inputs ---
    try {
        const posX = parseFloat(document.getElementById('customTypePosX').value) || 0;
        const posY = parseFloat(document.getElementById('customTypePosY').value) || 0;
        const posZ = parseFloat(document.getElementById('customTypePosZ').value) || 0;
        
        const rotY = parseFloat(document.getElementById('customTypeRotY').value) || 0;
        const rotX = parseFloat(document.getElementById('customTypeRotX').value) || 0;
        const rotZ = parseFloat(document.getElementById('customTypeRotZ').value) || 0;
        
        const scale = parseFloat(document.getElementById('customTypeScale').value) || 1;

        const newDefault = {
            position: [posX, posY, posZ],
            rotation: [rotY, rotX, rotZ], // Y, X, Z
            scale: scale
        };
        
        // --- 4. Set temporary global fallback ---
        window.globalModelFactory.globalFallbackAnchors[finalItemType] = newDefault;
        window.tempPreviewFallbackType = finalItemType;
        
        // --- 5. Register temporary item ---
        const fileUrl = URL.createObjectURL(file); // Create a new URL
        window.tempPreviewItemName = "__preview_item__" + Date.now();
        window.tempPreviewItemType = finalItemType;
        
        window.shopItems[window.tempPreviewItemName] = {
            title: "Preview Item",
            type: finalItemType,
            file: fileUrl, // Use the local object URL
            materials: [ { type: "default_primary_color" }, { type: "default_secondary_color" } ],
            preview_rotation: [180, 0, 0]
        };

        // --- 6. Equip items on mannequin ---
        const defaultParentName = window.globalModelFactory.defaults[parentType].file;
        await window.previewMannequin.equipItem(defaultParentName, parentType);
        await window.previewMannequin.equipItem(window.tempPreviewItemName, finalItemType);
        
        console.log("Live preview updated");

    } catch (e) {
        console.error("Error updating live preview:", e);
    }
}
// --- END MODIFICATION ---

/**
 * Processes the selected file and registers it as a new item in window.shopItems.
 * Now also saves a new global fallback position if a custom type is defined.
 */
async function processAndRegisterCosmetic() {
    const fileInput = document.getElementById('modelUpload');
    const file = fileInput.files[0];
    
    if (!file) {
        alert('Please select a model file first (click "Upload Cosmetic").');
        return;
    }

    // Get model name, or generate from filename
    let modelName = document.getElementById('modelName').value.trim();
    if (!modelName) {
        modelName = file.name.split('.').slice(0, -1).join('.').replace(/\s+/g, '_').toLowerCase();
    }

    // Check for overwrite
    if (window.shopItems[modelName]) {
        if (!confirm(`An item named "${modelName}" already exists. Overwrite it?`)) {
            return;
        }
    }

    const attachmentTypeBase = document.getElementById('attachmentTypeInput').value.trim();
    const attachmentSide = document.getElementById('attachmentSide').value;

    // Combine type and side if needed
    let finalItemType = attachmentTypeBase;
    if (attachmentSide !== 'none') {
        if (attachmentTypeBase === 'hand') finalItemType = `hand/${attachmentSide}`;
        else if (attachmentTypeBase === 'body/badge') finalItemType = `body/badge/${attachmentSide}`;
        else if (attachmentTypeBase === 'grapple/hook') finalItemType = `grapple/hook/${attachmentSide}`;
        else finalItemType = `${attachmentTypeBase}/${attachmentSide}`;
    }

    if (!finalItemType) {
        alert('Attachment Type cannot be empty.');
        return;
    }

    // --- Save custom type default position ---
    const customTypeSetup = document.getElementById('customTypeSetup');
    if (customTypeSetup.style.display === 'block') {
        try {
            const posX = parseFloat(document.getElementById('customTypePosX').value) || 0;
            const posY = parseFloat(document.getElementById('customTypePosY').value) || 0;
            const posZ = parseFloat(document.getElementById('customTypePosZ').value) || 0;
            
            const rotY = parseFloat(document.getElementById('customTypeRotY').value) || 0;
            const rotX = parseFloat(document.getElementById('customTypeRotX').value) || 0;
            const rotZ = parseFloat(document.getElementById('customTypeRotZ').value) || 0;
            
            const scale = parseFloat(document.getElementById('customTypeScale').value) || 1;

            const newDefault = {
                position: [posX, posY, posZ],
                rotation: [rotY, rotX, rotZ], // Y, X, Z
                scale: scale
            };

            // Save to the global factory instance
            if (window.globalModelFactory) {
                window.globalModelFactory.globalFallbackAnchors[finalItemType] = newDefault;
                console.log(`✅ Saved new global fallback for type "${finalItemType}":`, newDefault);

                // --- MODIFICATION: Add to dualSlotBaseTypes if checked ---
                const isDualItem = document.getElementById('attachmentDualItem').checked;
                if (isDualItem) {
                    // Add the BASE type (e.g., "body/new_thing") to the set
                    window.globalModelFactory.dualSlotBaseTypes.add(attachmentTypeBase);
                    console.log(`✅ Registered "${attachmentTypeBase}" as a new dual-slot item type.`);
                }
                // --- END MODIFICATION ---

            } else {
                console.warn('window.globalModelFactory not found, could not save new fallback position.');
            }

        } catch (e) {
            console.error('Error parsing custom type transform:', e);
            alert('Invalid number in custom type position/rotation/scale.');
            return;
        }
    }

    const fileUrl = URL.createObjectURL(file); // Local URL for the new item

    // Create a new config for the custom item
    const newItemConfig = {
        title: modelName.replace(/_/g, ' '),
        type: finalItemType,
        file: fileUrl, // Use the local object URL
        materials: [ 
            { type: "default_primary_color" },
            { type: "default_secondary_color" } 
        ], 
        preview_rotation: [180, 0, 0] // Default rotation for preview
    };

    // Add to global shop items and clear cache
    window.shopItems[modelName] = newItemConfig;
    previewCache.clear(); 

    console.log(`✅ Custom cosmetic "${modelName}" registered:`, newItemConfig);
    alert(`Successfully registered custom cosmetic: "${modelName}"`);

    // Refresh item lists if they exist
    if (typeof filterItems === 'function') {
        filterItems(); 
    }
    if (typeof filterPlayerItems === 'function') {
        filterPlayerItems(); 
    }

    // --- MODIFICATION: Call closeCosmeticUploader *after* teardown ---
    teardownCustomTypePreview(); // Clean up the mannequin
    closeCosmeticUploader(); // Now close the overlay
    // --- END MODIFICATION ---
}
// --- Wire up Cosmetic Uploader Buttons ---
try {
    const uploadButton = document.getElementById('uploadButton');
    if (uploadButton) {
        // "Upload" button actually just clicks the hidden file input
        uploadButton.onclick = () => document.getElementById('modelUpload').click();
    }
    
    const doneButton = document.getElementById('doneButton');
    if (doneButton) {
        // "Done" button processes the file
        doneButton.onclick = processAndRegisterCosmetic;
    }
    
    const nextButton = document.getElementById('nextButton');
    if (nextButton) {
        // This button acts as a "Cancel" button
        nextButton.textContent = 'Cancel';
        nextButton.onclick = closeCosmeticUploader; // MODIFIED
    }
    
    const modelUploadInput = document.getElementById('modelUpload');
    if (modelUploadInput) {
        // When a file is selected...
        modelUploadInput.onchange = (event) => {
            const file = event.target.files[0];
            const uploadButton = document.getElementById('uploadButton');
            if (file) {
                // Auto-fill name input if empty
                let modelNameInput = document.getElementById('modelName');
                if (!modelNameInput.value) {
                     modelNameInput.value = file.name.split('.').slice(0, -1).join('.').replace(/\s+/g, '_').toLowerCase();
                }
                // Update button text and color to show file is selected
                uploadButton.textContent = file.name;
                uploadButton.style.backgroundColor = '#28a745'; // Green
            } else {
                // Reset button
                uploadButton.textContent = 'Upload Cosmetic';
                uploadButton.style.backgroundColor = '#3b82f6'; // Blue
            }
        };
    }
} catch (error) {
    console.error("Failed to wire up cosmetic uploader listeners:", error);
}

// Expose uploader functions globally
window.openCosmeticUploader = openCosmeticUploader;
window.closeCosmeticUploader = closeCosmeticUploader;
// --- MODIFICATION: Expose live update function globally for HTML oninput ---
window.liveUpdateCustomTypePreview = liveUpdateCustomTypePreview;
// --- END MODIFICATION ---


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
    alert("❌ Error: " + msg + "\nLine: " + line + ":" + col);
    console.error("❌ JS Error:", msg, url, line, col, error);
};

// Catch errors inside async loaders / Promises (like glTF loader)
window.addEventListener("unhandledrejection", function (event) {
    alert("❌ Promise Error: " + event.reason);
    console.error("❌ Unhandled Promise Rejection:", event.reason);
});
