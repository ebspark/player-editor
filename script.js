
const skyVS = `
    varying vec3 vWorldPosition;

    void main()
    {
        vec3 rotatedPosition = (modelViewMatrix * vec4(position, 0.0)).xyz;
        gl_Position = projectionMatrix * vec4(rotatedPosition, 0.0);
        gl_Position.z = gl_Position.w;

        vWorldPosition = position;
    }`;

const skyFS = `
    varying vec3 vWorldPosition;

    uniform vec3 cameraFogColor0;
    uniform vec3 cameraFogColor1;
    uniform float sunSize;

    uniform vec3 sunColor;
    uniform vec3 sunDirection;

    void main()
    {
        vec3 cameraToVertex = normalize(vWorldPosition);

        float horizonFactor = 1.0 - clamp(abs(cameraToVertex.y) / 0.8, 0.0, 1.0);
        vec3 fogColor = mix(cameraFogColor1.rgb, cameraFogColor0.rgb, horizonFactor * horizonFactor);
        vec4 color = vec4(fogColor, 1.0);

        float sunAngle = acos(dot(sunDirection, -cameraToVertex));
        float realSunSize = 0.05 * sunSize;
        float sunGlowSize = sunSize;
        float sunFactor = clamp((sunGlowSize - sunAngle) / sunGlowSize, 0.0, 1.0);
        sunFactor *= sunFactor;
        if(sunAngle < realSunSize) sunFactor = 1.5;
        color.rgb = mix(color.rgb, sunColor, sunFactor);

        gl_FragColor = color;
        #include <colorspace_fragment>
    }`;
let scene, camera, renderer, controls, transformControls;
window.scene = null;
let selectionMaskTarget;
let selectionMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff
});

let sgmWorkerPool;


let blackMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000
});
let multiSelectGroup = null;

let selectedObjectsForOutline = [];
let composer, outlinePass;
let selectedPlayer = null;

window.shopItems = {};

let genericItemGrid;
let selectionBox, selectionHelper;


let previewGrid;
let globalModelFactory;
let previewCache = new Map(); 


window.attachmentMode = 'child'; 

window.toggleAttachmentMode = function() {
    const btn = document.getElementById('attachmentModeBtn');
    if (window.attachmentMode === 'child') {
        window.attachmentMode = 'parent';
        btn.innerText = 'PARENT';
        btn.style.color = '#ff5555';
    } else {
        window.attachmentMode = 'child';
        btn.innerText = 'CHILD';
        btn.style.color = '#55ff55';
    }
    
    if (window.updateJsonEditorContent && selectedObjectsForOutline) {
        window.updateJsonEditorContent(selectedObjectsForOutline);
    }

    
    
    if (window.updateAttachmentPreview && selectedObjectsForOutline && selectedObjectsForOutline.length > 0) {
        window.updateAttachmentPreview(selectedObjectsForOutline[0]);
    }
};


async function fetchShopItems() {
    try {
        const response = await fetch('https://api.slin.dev/grab/v1/get_shop_items?version=3');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        window.shopItems = await response.json();
        previewCache.clear(); // <-- ADD THIS LINE
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
    const objectURL = URL.createObjectURL(file);

    const onModelLoaded = (model) => {
        model.name = filename; 
        scene.add(model);
        console.log(`Successfully imported ${filename}`);
        URL.revokeObjectURL(objectURL); 
    };

    const onError = (error) => {
        console.error(`Error loading file ${filename}:`, error);
        alert(`Failed to load ${filename}. See console for details.`);
        URL.revokeObjectURL(objectURL); 
    };

    switch (extension) {
        case 'sgm':
            {
                
                
                
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

    
    event.target.value = '';
}

function getCanvasSize() {
  const rect = document.getElementById('canvas-container').getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  return {
    width: rect.width,
    height: rect.height,
    pixelWidth: rect.width * dpr,
    pixelHeight: rect.height * dpr,
    dpr
  };
}



function initScene() {
    sgmWorkerPool = new WorkerPool('./SGMWorker.js'); 
    window.scene = new THREE.Scene();
    scene = window.scene;
const sunAngle = new THREE.Euler(THREE.MathUtils.degToRad(45), THREE.MathUtils.degToRad(315), 0.0);
    const sunAltitude = 45.0;
    const horizonColor = [0.916, 0.9574, 0.9574]; 
    const zenithColor = [0.28, 0.476, 0.73];    
    const sunDirection = new THREE.Vector3(0, 0, 1).applyEuler(sunAngle);

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
        side: THREE.BackSide,
        depthWrite: false,
        flatShading: false,
    });

    
    const skyGeometry = new THREE.SphereGeometry(500, 32, 16);
    
    const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    
    skyMesh.renderOrder = 1000; 
    skyMesh.frustumCulled = false; 
    skyMesh.userData.ignoreInRaycast = true;

    scene.add(skyMesh);
    const { width, height, pixelWidth, pixelHeight, dpr } = getCanvasSize();

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = false; 

    const canvasContainer = document.getElementById('canvas-container');
    canvasContainer.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 2.25, 5);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    composer = new THREE.EffectComposer(renderer);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);

    const renderPass = new THREE.RenderPass(scene, camera);
    composer.addPass(renderPass);

    const OutlineShader = {
        uniforms: {
            'tDiffuse': { value: null },
            'tSelectionMask': { value: null },
            'uOutlineColor': { value: new THREE.Color(0xffa500) },
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

                if (ownMaskColor.r == 0.0 && ownMaskColor.g == 0.0 && ownMaskColor.b == 0.0) {
                    gl_FragColor = baseColor;
                    return;
                }

                vec2 texelSize = 1.0 / uResolution;
                float isEdge = 0.0;

                vec4 neighborN = texture2D(tSelectionMask, vUv + vec2(0.0, texelSize.y));
                vec4 neighborS = texture2D(tSelectionMask, vUv - vec2(0.0, texelSize.y));
                vec4 neighborE = texture2D(tSelectionMask, vUv + vec2(texelSize.x, 0.0));
                vec4 neighborW = texture2D(tSelectionMask, vUv - vec2(texelSize.x, 0.0));

                if (distance(ownMaskColor, neighborN) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborS) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborE) > 0.001) isEdge = 1.0;
                if (distance(ownMaskColor, neighborW) > 0.001) isEdge = 1.0;

                if (isEdge > 0.5) {
                    gl_FragColor = vec4(uOutlineColor, 1.0);
                } else {
                    gl_FragColor = baseColor;
                }
            }
        `
    };

    outlinePass = new THREE.ShaderPass(OutlineShader);
    outlinePass.renderToScreen = true;
    composer.addPass(outlinePass);

    selectionMaskTarget = new THREE.WebGLRenderTarget(pixelWidth, pixelHeight);
    outlinePass.uniforms.tSelectionMask.value = selectionMaskTarget.texture;

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Shift') controls.enabled = false;
    });

    document.addEventListener('keyup', (event) => {
        if (event.key === 'Shift' && !selectionHelper.isDown) controls.enabled = true;
    });

const hemiLight = new THREE.HemisphereLight(
    0xffffff, 
    0x8d8d8d, 
    2.0       
);
hemiLight.position.set(0, 50, 0);
scene.add(hemiLight);


const mainLight = new THREE.DirectionalLight(0xffffff, 3.0);
mainLight.position.set(5, 10, 7.5);
mainLight.castShadow = false; 

scene.add(mainLight);



    const gridHelper = new THREE.GridHelper(20, 20);
    gridHelper.position.y = -5;
    scene.add(gridHelper);

    transformControls = new THREE.TransformControls(camera, renderer.domElement);
    scene.add(transformControls);
    

transformControls.addEventListener('objectChange', () => {
  if (transformControls.getMode() === 'scale') {
    const obj = transformControls.object;
    if (!obj) return;

    
    const axis = transformControls.axis; 

    if (axis) {
      
      let s;
      switch (axis) {
        case 'X': s = obj.scale.x; break;
        case 'Y': s = obj.scale.y; break;
        case 'Z': s = obj.scale.z; break;
        default:  s = (obj.scale.x + obj.scale.y + obj.scale.z) / 3; 
      }
      obj.scale.set(s, s, s);
    }
  }
});

    selectionBox = new SelectionBox(camera, scene);
    selectionHelper = new SelectionHelper(renderer, 'selection-box');

    const editPlayerBtn = document.getElementById('editPlayerBtn');
    const attachmentModeBtn = document.getElementById('attachmentModeBtn'); 

    
    transformControls.addEventListener('attach', () => {
        const object = transformControls.object;
        if (!object) {
            editPlayerBtn.style.display = 'none';
            attachmentModeBtn.style.display = 'none';
            selectedPlayer = null;
            return;
        }

        
        let playerRoot = object;
        while (playerRoot.parent && !playerRoot.userData.isPlayer) {
            playerRoot = playerRoot.parent;
        }
        if (playerRoot.userData.isPlayer) {
            selectedPlayer = playerRoot.userData.playerInstance;
            editPlayerBtn.style.display = 'inline-block';
        } else {
            selectedPlayer = null;
            editPlayerBtn.style.display = 'none';
        }

        
        let itemToCheck = object;
        
        while (itemToCheck && !itemToCheck.userData.isItem && itemToCheck.parent) {
            itemToCheck = itemToCheck.parent;
        }
        
        const isChildAttachment = itemToCheck &&
                                    itemToCheck.userData.isItem &&
                                    itemToCheck.parent &&
                                    itemToCheck.parent.userData.isItem &&
                                    !itemToCheck.parent.userData.isPlayer; 

        if (attachmentModeBtn) {
            attachmentModeBtn.style.display = isChildAttachment ? 'inline-block' : 'none';
        }
    });
    
    transformControls.addEventListener('detach', () => {
        selectedPlayer = null;
        editPlayerBtn.style.display = 'none';
        attachmentModeBtn.style.display = 'none'; 
    });

    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;

        
        if (event.value === false) { 
            const childModel = transformControls.object;
            if (!childModel) return;

            const parentModel = childModel.parent;

            
            if (
                !parentModel ||
                !childModel.userData.isItem ||
                !parentModel.userData.isItem ||
                parentModel.userData.isPlayer ||
                parentModel === scene ||
                parentModel === multiSelectGroup
            ) {
                return;
            }

            

const radToDeg = THREE.MathUtils.radToDeg;

            
            
            
            childModel.rotation.order = 'YXZ';

            const newOverride = {
                position: childModel.position.toArray().map(v => parseFloat(v.toFixed(6))),
                rotation: [
                    
                    radToDeg(childModel.rotation.y), 
                    radToDeg(childModel.rotation.x), 
                    radToDeg(childModel.rotation.z)  
                ].map(v => parseFloat(v.toFixed(3))),
                scale: parseFloat(childModel.scale.x.toFixed(4))
            };
            

            if (window.attachmentMode === 'child') {
                
                const childName = childModel.name;
                const parentName = parentModel.name;
                const childConfig = window.shopItems[childName];

                if (childConfig && parentName) {
                    if (!childConfig.attachment_point_overrides) {
                        childConfig.attachment_point_overrides = {};
                    }
                    childConfig.attachment_point_overrides[parentName] = newOverride;
                    console.log(`Saved CHILD override for ${childName} on ${parentName}:`, newOverride);
                }
            } else {
                 
                 const parentName = parentModel.name;
                 const parentConfig = window.shopItems[parentName];
                 
                 
                 const fullSlotPath = childModel.userData.slotPath;
                 const parentType = parentConfig.type;

                 if (parentConfig && fullSlotPath) {
                     
                     let relativePath = fullSlotPath.startsWith(parentType + '/')
                        ? fullSlotPath.substring(parentType.length + 1)
                        : fullSlotPath;

                     
                     if (!parentConfig.attachment_points) parentConfig.attachment_points = {};
                     let target = parentConfig.attachment_points;
                     const parts = relativePath.split('/');
                     
                     for(let i=0; i < parts.length - 1; i++) {
                          if (!target[parts[i]]) target[parts[i]] = {};
                          target = target[parts[i]];
                     }
                     const lastPart = parts[parts.length-1];

                     
                     target[lastPart] = newOverride;
                     console.log(`Saved PARENT attachment default for ${parentName} at ${relativePath}:`, newOverride);
                 }
            }

            
if (window.updateJsonEditorContent && selectedObjectsForOutline) {
                window.updateJsonEditorContent(selectedObjectsForOutline);
            }
            
            
            
            if (window.updateAttachmentPreview) {
                window.updateAttachmentPreview(childModel); 
            }
        }
    });
    window.addEventListener('resize', onWindowResize, false);

    
    const previewBar = document.getElementById('ae-preview-bar');
    if (previewBar) {
        previewGrid = new ModelGridComponent(previewBar, {
            itemSize: 100,
            gap: 10,
        });
        console.log(' Attachment preview grid initialized.');
    } else {
        console.warn(' Could not find #ae-preview-bar element.');
    }

    const horizontalScroller = document.getElementById('ae-preview-bar');

    horizontalScroller.addEventListener('wheel', (event) => {
        event.preventDefault(); 

        
        horizontalScroller.scrollBy({
            left: event.deltaY*4,
            behavior: 'smooth'
        });
    });


    initializeSelection();
    animate();
}

function onWindowResize() {
    const { width, height, pixelWidth, pixelHeight, dpr } = getCanvasSize();


    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);

    composer.setPixelRatio(dpr);
    composer.setSize(width, height);

    selectionMaskTarget.setSize(pixelWidth, pixelHeight);
    outlinePass.uniforms.uResolution.value.set(pixelWidth, pixelHeight);
}

const originalStates = new Map();
const originalMaterials = new Map();
function isHelper(o) {
  
  if (isFromTransformControls(o)) return true;
  return o.isGridHelper || o.isAxesHelper || o.isCamera || o.isLight;
}
function animate() {
  requestAnimationFrame(animate);
  controls.update();

  const objectsToOutline = selectedObjectsForOutline.length ? selectedObjectsForOutline : [];

  if (objectsToOutline.length > 0) {
    const selectedUUIDs = new Set();
    objectsToOutline.forEach(root => root.traverse(ch => selectedUUIDs.add(ch.uuid)));

    const originalBackground = scene.background;
    scene.background = null;

    
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
    
    

    
    const hiddenNonMeshes = [];
    scene.traverse(child => {
      
      if (child.isMesh) {
        originalMaterials.set(child, child.material);
        child.material = selectedUUIDs.has(child.uuid)
          ? selectionMaterial
          : blackMaterial;
      } else if (child.isLine || child.isLineSegments || child.isPoints) {
        if (child.visible) {
          hiddenNonMeshes.push(child);
          child.visible = false;
        }
      }
    });

    
    renderer.setRenderTarget(selectionMaskTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    
    scene.background = originalBackground;
    scene.traverse(child => {
      if (originalMaterials.has(child)) {
        child.material = originalMaterials.get(child);
      }
    });
    originalMaterials.clear();

    
    hiddenNonMeshes.forEach(o => (o.visible = true));

    
    madeInvisible.forEach(o => (o.visible = true));

  } else {
    renderer.setRenderTarget(selectionMaskTarget);
    renderer.clear();
    renderer.setRenderTarget(null);
  }

  composer.render();
}


async function spawnDefaultPlayer() {
  
  const defaultConfig = {
    initialItems: {}, 
    colors: {
      primary: new THREE.Color(0x00ff00),
      secondary: new THREE.Color(0xff0000)
    },
    userInput: "DefaultPlayer"
  };

  const player = new Player(scene, window.shopItems, defaultConfig);
  await player.ready; 

  
  selectedPlayer = player;
  console.log("✅ Default player loaded into scene", player);
}
/**
 * Creates a single preview cell showing a parent-child combination.
 * @param {string} parentItemName - The item name (ID) of the parent model.
 * @param {string} parentItemType - The item type (e.g., "head") of the parent.
 * @param {string} childItemName - The item name (ID) of the child model.
 * @param {string} childItemType - The item type (e.g., "head/hat") of the child.
 * @param {object} colors - The primary/secondary colors to use.
 * @param {boolean} isParentSelected - True if the *user's original selection* was a parent item.
 */
async function createPreviewCell(parentItemName, parentItemType, childItemName, childItemType, colors, isParentSelected) {
    try {
        
        const parentAsset = await globalModelFactory.create({
            itemName: parentItemName,
            itemType: parentItemType,
            colors: colors
        });
        const parentModel = parentAsset.modelGroup;

        
        const childAsset = await globalModelFactory.create({
            itemName: childItemName,
            itemType: childItemType,
            colors: colors
        });
        const childModel = childAsset.modelGroup;

        
        const childConfig = window.shopItems[childItemName] || {};
        const parentConfig = window.shopItems[parentItemName] || {};

        
        const typeParts = childItemType.split('/');
        let slotPath;
        if (childItemType.startsWith('grapple/hook/')) {
            const side = typeParts.pop();
            slotPath = `rope/${side}/end`;
        } else {
            const parentType = typeParts[0];
            const sub = typeParts.slice(1).join('/');
            slotPath = `${parentType}/${sub}`; 
            if (childConfig.attachment_point) {
                slotPath = `${parentType}/${typeParts[1]}/${childConfig.attachment_point}`;
            }
        }

        
        const parentConfigWithId = { ...parentConfig, name: parentItemName };
        const finalTransform = window.MeshUtils.getAttachmentTransform(
            childConfig,
            parentModel,
            slotPath,
            parentConfigWithId,
            globalModelFactory.globalFallbackAnchors
        );

        
        window.MeshUtils.applyTransform(childModel, finalTransform);
        parentModel.add(childModel);

        
        
        
        
        
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

function generateChildPreviews(selectedParent, parentConfig, colors) {
    const previewPromises = [];
    const parentItemType = parentConfig.type;
    const childPrefix = `${parentItemType}/`;
    const isParentSelected = true; 

    for (const [itemName, config] of Object.entries(window.shopItems)) {
        if (config.type && config.type.startsWith(childPrefix)) {
            previewPromises.push(
                createPreviewCell(
                    selectedParent.name, 
                    parentItemType,      
                    itemName,            
                    config.type,         
                    colors,
                    isParentSelected
                )
            );
        }
    }
    return previewPromises;
}

function generateParentPreviews(selectedChild, childConfig, colors) {
    const previewPromises = [];
    const selectedItemType = childConfig.type;
    const parentType = selectedItemType.split('/')[0];
    const isParentSelected = false; 

    for (const [itemName, config] of Object.entries(window.shopItems)) {
        if (config.type === parentType) {
            previewPromises.push(
                createPreviewCell(
                    itemName,             
                    config.type,          
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
 * @param {object} data - The model data payload (parent, child, name, model)
 * @param {THREE.Object3D} selectedObject - The object that was selected to generate this preview.
 */
async function createPreviewClickHandler(data, selectedObject) {
    console.log("Clicked preview:", data.name);
    
    
    const itemConfig = selectedObject.userData.config || window.shopItems[selectedObject.name];
    if (!itemConfig) return; 
    const selectedItemType = itemConfig.type;
    
    
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

    
    
    const isSwitchingParent = selectedItemType.includes('/');
    const isSwitchingChild = !selectedItemType.includes('/') || (selectedItemType.includes('/') && window.attachmentMode === 'parent');

    if (isSwitchingParent && window.attachmentMode === 'child') {
        
        console.log(`Switching parent to: ${data.parent.name}`);
        await playerToUpdate.equipItem(data.parent.name, data.parent.type);
        
        newItemToSelect = playerToUpdate.activeModels[selectedItemType];
        newItemIsChildAttachment = (newItemToSelect && newItemToSelect.parent && newItemToSelect.parent.userData.isItem);
        
    } else if (isSwitchingChild) {
        
        
        
        console.log(`Equipping child: ${data.child.name}`);
        await playerToUpdate.equipItem(data.child.name, data.child.type);
        
        newItemToSelect = playerToUpdate.activeModels[data.child.type];
        newItemIsChildAttachment = true; 
    }


    
    if (newItemToSelect) {
        transformControls.attach(newItemToSelect);
        selectedObjectsForOutline = [newItemToSelect];
        
        selectedPlayer = playerToUpdate; 
        editPlayerBtn.style.display = 'inline-block';
        if (attachmentModeBtn) {
            attachmentModeBtn.style.display = newItemIsChildAttachment ? 'inline-block' : 'none';
        }

        
        
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
}

/**
 * Updates the attachment preview bar based on the selected object.
 * (NOW WITH CACHING)
 */
async function updateAttachmentPreview(selectedObject) {
    if (!previewGrid || !globalModelFactory) return; 
    
    if (!selectedObject || !selectedObject.userData.isItem) {
        previewGrid.clearAll(); 
        previewGrid.showEmptyState(); 
        return; 
    }

    
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
        return; 
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
        
        
        if (window.attachmentMode === 'child') {
            
            previewPromises = generateParentPreviews(selectedObject, itemConfig, colors);

        } else {
            
            const parentObject = selectedObject.parent;
            if (parentObject && parentObject.userData.isItem && !parentObject.userData.isPlayer) {
                const parentConfig = parentObject.userData.config || window.shopItems[parentObject.name];
                if (parentConfig) {
                    previewPromises = generateChildPreviews(parentObject, parentConfig, colors);
                }
            }
        }

    } else {
        
        
        previewPromises = generateChildPreviews(selectedObject, itemConfig, colors);
    }
    
    
    try {
        const models = await Promise.all(previewPromises);
        previewGrid.clearAll(); 
        
        let count = 0;
        
        models.reverse();

        
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
        }
    } catch (error) {
        console.error("Error generating previews:", error);
        previewGrid.grid.innerHTML = '<div class="empty-state">Error loading previews.</div>';
    }
}
window.updateAttachmentPreview = updateAttachmentPreview; 




/**
 * Opens the cosmetic uploader popup and resets its fields.
 */
function openCosmeticUploader() {
    const overlay = document.getElementById('attachmentOverlay');
    overlay.style.display = 'flex';

    
    document.getElementById('attachmentType').value = 'head/hat';
    document.getElementById('attachmentSide').value = 'none';
    document.getElementById('modelName').value = '';
    document.getElementById('sideSelection').style.display = 'none';
    
    
    const fileInput = document.getElementById('modelUpload');
    fileInput.value = ''; 
    
    
    const uploadButton = document.getElementById('uploadButton');
    uploadButton.textContent = 'Upload Cosmetic';
    uploadButton.style.backgroundColor = '#3b82f6'; 
}

/**
 * Closes the cosmetic uploader popup.
 */
function closeCosmeticUploader() {
    const overlay = document.getElementById('attachmentOverlay');
    overlay.style.display = 'none';
}

/**
 * Shows or hides the "Side" dropdown based on the selected attachment type.
 */
function handleAttachmentTypeChange() {
    const type = document.getElementById('attachmentType').value;
    const sideSelection = document.getElementById('sideSelection');
    
    if (type.startsWith('hand') || type.startsWith('body/badge')) {
        sideSelection.style.display = 'block';
    } else {
        sideSelection.style.display = 'none';
        document.getElementById('attachmentSide').value = 'none'; 
    }
}

/**
 * Processes the selected file and registers it as a new item in window.shopItems.
 */
async function processAndRegisterCosmetic() {
    const fileInput = document.getElementById('modelUpload');
    const file = fileInput.files[0];
    
    if (!file) {
        
        alert('Please select a model file first (click "Upload Cosmetic").');
        return;
    }

    let modelName = document.getElementById('modelName').value.trim();
    if (!modelName) {
        
        modelName = file.name.split('.').slice(0, -1).join('.').replace(/\s+/g, '_').toLowerCase();
    }

    if (window.shopItems[modelName]) {
        
        if (!confirm(`An item named "${modelName}" already exists. Overwrite it?`)) {
            return;
        }
    }

    const attachmentTypeBase = document.getElementById('attachmentType').value;
    const attachmentSide = document.getElementById('attachmentSide').value;

    let finalItemType = attachmentTypeBase;
    
    if (attachmentSide !== 'none') {
        
        if (attachmentTypeBase === 'hand') {
            finalItemType = `hand/${attachmentSide}`;
        } else {
            finalItemType = `${attachmentTypeBase}/${attachmentSide}`;
        }
    }

    const fileUrl = URL.createObjectURL(file);

    const newItemConfig = {
        title: modelName.replace(/_/g, ' '),
        type: finalItemType,
        file: fileUrl, 
        materials: [ 
            { type: "default_primary_color" },
            { type: "default_secondary_color" } 
        ], 
        
        preview_rotation: [180, 0, 0] 
    };

    
    window.shopItems[modelName] = newItemConfig;
    previewCache.clear(); 

    console.log(`✅ Custom cosmetic "${modelName}" registered:`, newItemConfig);
    alert(`Successfully registered custom cosmetic: "${modelName}"`);

    
    
    if (typeof filterItems === 'function') {
        filterItems(); 
    }
    if (typeof filterPlayerItems === 'function') {
        filterPlayerItems(); 
    }

    closeCosmeticUploader();
}



try {
    const uploadButton = document.getElementById('uploadButton');
    if (uploadButton) {
        uploadButton.onclick = () => document.getElementById('modelUpload').click();
    }
    
    const doneButton = document.getElementById('doneButton');
    if (doneButton) {
        doneButton.onclick = processAndRegisterCosmetic;
    }
    
    const nextButton = document.getElementById('nextButton');
    if (nextButton) {
        nextButton.textContent = 'Cancel';
        nextButton.onclick = closeCosmeticUploader;
    }

    const attachmentTypeSelect = document.getElementById('attachmentType');
    if (attachmentTypeSelect) {
        attachmentTypeSelect.onchange = handleAttachmentTypeChange;
    }
    
    const modelUploadInput = document.getElementById('modelUpload');
    if (modelUploadInput) {
        modelUploadInput.onchange = (event) => {
            const file = event.target.files[0];
            const uploadButton = document.getElementById('uploadButton');
            if (file) {
                let modelNameInput = document.getElementById('modelName');
                if (!modelNameInput.value) {
                     modelNameInput.value = file.name.split('.').slice(0, -1).join('.').replace(/\s+/g, '_').toLowerCase();
                }
                uploadButton.textContent = file.name;
                uploadButton.style.backgroundColor = '#28a745'; 
            } else {
                uploadButton.textContent = 'Upload Cosmetic';
                uploadButton.style.backgroundColor = '#3b82f6'; 
            }
        };
    }
} catch (error) {
    console.error("Failed to wire up cosmetic uploader listeners:", error);
}


window.openCosmeticUploader = openCosmeticUploader;
window.closeCosmeticUploader = closeCosmeticUploader;





(async () => {
  await fetchShopItems();
  
  if (window.PlayerModelFactory) {
      globalModelFactory = new window.PlayerModelFactory(window.shopItems);
  } else {
      console.error("PlayerModelFactory not found on window!");
  }
  
  initScene();
  await spawnDefaultPlayer();
})();