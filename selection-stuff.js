/**
 * @file Handles all object selection logic, including
 * single-click (with double-click for player), box selection,
 * and managing the multi-select group.
 */


// --- GLOBALS for Selection ---

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastClickTime = 0;
let lastSelectedPart = null;
const DOUBLE_CLICK_DELAY = 300; // ms
let pointerDownStart = null; // Tracks start of a click {x, y}
const CLICK_DRAG_THRESHOLD = 5; // pixels
let lastSelectedPlayerRoot = null; // For double-click detection

const _box = new THREE.Box3(); // Reusable Box3 for calculations

// --- HELPER FUNCTIONS ---

/**
 * Checks if an object is part of the transform controls gizmo.
 * @param {THREE.Object3D} obj - The object to check.
 * @returns {boolean} True if the object is part of the gizmo.
 */
function isFromTransformControls(obj) {
    while (obj) {
        if (obj === transformControls) return true;
        obj = obj.parent;
    }
    return false;
}

/**
 * (Unused in this file) Traverses an object to find all mesh parts.
 * @param {THREE.Object3D} parentObject
 * @returns {THREE.Mesh[]} Array of mesh parts.
 */
function getAtomicSelection(parentObject) {
    const parts = [];
    if (!parentObject) return parts;

    parentObject.traverse(child => {
        if (child.isMesh) {
            parts.push(child);
        }
    });
    
    if (parentObject.isMesh && parts.length === 0) {
        parts.push(parentObject);
    }
    return parts;
}

/**
 * Dismantles any temporary multi-select group, re-parents objects back to the scene,
 * and clears all selection state (gizmo, outlines).
 */
function ungroupAndDeselect() {
  
  // If a multi-select group exists
  if (multiSelectGroup) {
    
    // Detach gizmo if it's attached to the group
    if (transformControls.object === multiSelectGroup) {
      transformControls.detach();
    }

    // Move all children from the group back to the main scene
    while (multiSelectGroup.children.length > 0) {
      scene.attach(multiSelectGroup.children[0]);
    }

    // Remove the empty group
    scene.remove(multiSelectGroup);
    multiSelectGroup = null;
  }

  // Detach gizmo if it's attached to a single object
  if (transformControls.object) {
    transformControls.detach();
  }

  // Clear selection states
  selectedObjectsForOutline = [];
  selectedPlayer = null;
  lastSelectedPart = null;
  lastSelectedPlayerRoot = null;
  
  // Update UI (JSON editor)
  if (window.updateJsonEditorContent) {
    window.updateJsonEditorContent(selectedObjectsForOutline);
  }

  // Update UI (Attachment preview)
  if (window.updateAttachmentPreview) {
    window.updateAttachmentPreview(null);
  }
}

/**
 * Performs a box selection using the SelectionBox class.
 * @param {THREE.Vector2} startPoint - Screen coordinates of selection start.
 * @param {THREE.Vector2} endPoint - Screen coordinates of selection end.
 * @returns {THREE.Object3D[]} Array of selected objects.
 */
function performBoxSelection(startPoint, endPoint) {
    
    // Get canvas position
    const rect = renderer.domElement.getBoundingClientRect();

    // Convert screen coordinates (pixels) to NDC (Normalized Device Coordinates, -1 to +1)
    const start = new THREE.Vector3(
        ((startPoint.x - rect.left) / rect.width) * 2 - 1,
        -((startPoint.y - rect.top) / rect.height) * 2 + 1,
        0.5
    );
    const end = new THREE.Vector3(
        ((endPoint.x - rect.left) / rect.width) * 2 - 1,
        -((endPoint.y - rect.top) / rect.height) * 2 + 1,
        0.5
    );
    
    // Get all meshes intersecting the selection frustum
    const allHitObjects = selectionBox.select(start, end);
    
    // Filter out gizmo parts and other ignored objects
    const filteredHits = allHitObjects.filter(h => !isFromTransformControls(h) && !h.userData.ignoreInRaycast);

    const finalSelections = new Set();

    // Traverse up from each hit mesh to find the "selectable" parent
    filteredHits.forEach(hit => {
        let selectablePart = hit;
        while (selectablePart.parent && selectablePart.parent !== scene) {
            // Stop if we hit a player
            if (selectablePart.parent.userData.isPlayer) {
                break;
            }
            // Stop if we hit an object marked as a selectable item
            if (selectablePart.userData.isSelectableItem) { // Note: isSelectableItem seems unused, isItem is used
                break;
            }
            selectablePart = selectablePart.parent;
        }
        finalSelections.add(selectablePart);
    });

    return Array.from(finalSelections);
}

/**
 * Handles a single-click event for object selection.
 * - Finds the clicked object via raycasting.
 * - Implements double-click logic to select the full player.
 * - Attaches the transform controls to the selected object.
 * @param {PointerEvent} event - The pointer event.
 */
function executeSingleClick(event) {
  if (transformControls.dragging) return; // Don't select if dragging gizmo

  // Get mouse position in NDC
  const rect = renderer.domElement.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);

  // Find intersected objects
  const hits = raycaster
    .intersectObjects(scene.children, true)
    .filter(h => !isFromTransformControls(h.object) && !h.object.userData.ignoreInRaycast);

  // Clicked on empty space
  if (hits.length === 0) {
    ungroupAndDeselect();
    return;
  }

  // Find the most relevant clicked objects
  const firstHit = hits[0].object;
  let cosmeticPart = null;
  let playerRoot = null;
  let cur = firstHit;
  while (cur && cur !== scene) {
    if (!cosmeticPart && cur.userData?.isItem) { // Find the closest "item"
      cosmeticPart = cur;
    }
    if (cur.userData?.isPlayer) { // Find the player root
      playerRoot = cur;
      break; 
    }
    cur = cur.parent;
  }

  // --- Double-Click Logic ---
  const now = performance.now();
  const isDoubleClick =
    playerRoot && // Clicked on a player
    lastSelectedPlayerRoot === playerRoot && // Clicked on the same player as last time
    (now - lastClickTime) < DOUBLE_CLICK_DELAY; // Clicked quickly

  
  let objectToAttach = null;
  if (playerRoot && isDoubleClick) {
    // Double-click on player: select the whole player root
    objectToAttach = playerRoot;
  } else if (cosmeticPart) {
    // Single-click on cosmetic: select the cosmetic part
    objectToAttach = cosmeticPart;
  } else {
    // Single-click on other: select the object's root (or player root if part of player)
    let obj = objectToAttach || firstHit;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    objectToAttach = obj;
  }

  if (objectToAttach) {
    // If this is a new selection, clear the old one
    if (objectToAttach !== transformControls.object) {
      ungroupAndDeselect();
      transformControls.attach(objectToAttach);
    }
    
    // Set object for outlining
    selectedObjectsForOutline = [objectToAttach];

    // Update UI
    if (window.updateJsonEditorContent) {
      window.updateJsonEditorContent(selectedObjectsForOutline);
    }
    if (window.updateAttachmentPreview) {
        window.updateAttachmentPreview(objectToAttach);
    }
    
    // Update attachment mode button visibility
    const attachmentModeBtn = document.getElementById('attachmentModeBtn');
    if (attachmentModeBtn) {
        let itemToCheck = objectToAttach;
        while (itemToCheck && !itemToCheck.userData.isItem && itemToCheck.parent) {
            itemToCheck = itemToCheck.parent;
        }
        const isChildAttachment = itemToCheck && 
                                  itemToCheck.userData.isItem && 
                                  itemToCheck.parent && 
                                  itemToCheck.parent.userData.isItem;

        attachmentModeBtn.style.display = isChildAttachment ? 'flex' : 'none';
    }
  }

  // Store state for next click (double-click detection)
  lastClickTime = now;
  lastSelectedPart = cosmeticPart || null;
  lastSelectedPlayerRoot = playerRoot || null;
}


// --- POINTER EVENT MANAGERS ---

/**
 * Tracks the start of a potential click (on pointer down).
 */
function onPointerDownManager(event) {
    // Only track left-clicks that are NOT shift-clicks (shift is for box select)
    if (event.button !== 0 || event.shiftKey) {
        pointerDownStart = null;
        return;
    }
    if (transformControls.dragging) return;
    pointerDownStart = { x: event.clientX, y: event.clientY };
}

/**
 * If the mouse moves too far, cancel the "click" action.
 */
function onPointerMoveManager(event) {
    if (!pointerDownStart) return;
    const dist = Math.hypot(event.clientX - pointerDownStart.x, event.clientY - pointerDownStart.y);
    if (dist > CLICK_DRAG_THRESHOLD) {
        // It's a drag, not a click
        pointerDownStart = null;
    }
}

/**
 * Master pointer up handler that determines if the action was a single click
 * or the end of a box selection.
 */
function onPointerUp(event) {
    const dragThreshold = 5;
    const startPoint = selectionHelper._startPoint; // From SelectionHelper
    const endPoint = new THREE.Vector2(event.clientX, event.clientY);

    // --- Case 1: End of a Box Selection ---
    // (Box selection is active and mouse moved significantly)
    if (selectionHelper.isDown && startPoint.distanceTo(endPoint) > dragThreshold) {
        
        transformControls.detach(); // Detach from any previous selection

        // Get selected objects
        const selectedParents = performBoxSelection(startPoint, endPoint);

        ungroupAndDeselect(); // Clear any previous state

        if (selectedParents.length === 1) {
            // --- Box selected one object ---
            transformControls.attach(selectedParents[0]);
            selectedObjectsForOutline = selectedParents;
            if (window.updateAttachmentPreview) {
                window.updateAttachmentPreview(selectedParents[0]);
            }
        } else if (selectedParents.length > 1) {
            // --- Box selected multiple objects ---
            // Create a temporary group
            multiSelectGroup = new THREE.Group();
            scene.add(multiSelectGroup);
            // Attach all selected objects to the group
            selectedParents.forEach(p => multiSelectGroup.attach(p));
            // Attach the gizmo to the group
            transformControls.attach(multiSelectGroup);
            selectedObjectsForOutline = selectedParents;
        }

        // Update UI
        if (window.updateJsonEditorContent) {
          window.updateJsonEditorContent(selectedObjectsForOutline);
        }

        // Clean up SelectionHelper state
        selectionHelper.isDown = false;
        selectionHelper._onSelectOver(); // Hides the selection box UI
        controls.enabled = true; // Re-enable orbit controls
        return;
    }

    // --- Case 2: End of a Single Click ---
    // (A click was started and did not move far)
    if (!pointerDownStart) return; // Not a click (was a drag or right/shift click)
    const dist = Math.hypot(event.clientX - pointerDownStart.x, event.clientY - pointerDownStart.y);
    pointerDownStart = null;
    
    if (dist <= dragThreshold) {
        selectedObjectsForOutline = []; // Clear outlines before new click
        executeSingleClick(event); // Handle the single-click logic
    }
}


/**
 * Initializes the selection system by adding the event listeners.
 */
function initializeSelection() {
    // These listeners manage the "is this a click or a drag?" logic
    renderer.domElement.addEventListener('pointerdown', onPointerDownManager, false);
    renderer.domElement.addEventListener('pointermove', onPointerMoveManager, false);
    // This listener executes the click or box selection
    renderer.domElement.addEventListener('pointerup', onPointerUp, false);
}


// === THREE.js ADDON: SelectionBox ===
// (This is a modified version of a Three.js addon)
// ... (code is heavily math-based for frustum calculation) ...

const _frustum = new THREE.Frustum();
const _center = new THREE.Vector3();
const _tmpPoint = new THREE.Vector3();
const _vecNear = new THREE.Vector3();
const _vecTopLeft = new THREE.Vector3();
const _vecTopRight = new THREE.Vector3();
const _vecDownRight = new THREE.Vector3();
const _vecDownLeft = new THREE.Vector3();
const _vecFarTopLeft = new THREE.Vector3();
const _vecFarTopRight = new THREE.Vector3();
const _vecFarDownRight = new THREE.Vector3();
const _vecFarDownLeft = new THREE.Vector3();
const _vectemp1 = new THREE.Vector3();
const _vectemp2 = new THREE.Vector3();
const _vectemp3 = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * This class can be used to select 3D objects in a scene with a selection box.
 * It creates a view frustum from the 2D screen selection and finds
 * all objects that intersect it.
 */
class SelectionBox {
    constructor(camera, scene, deep = Number.MAX_VALUE) {
        this.camera = camera;
        this.scene = scene;
        this.startPoint = new THREE.Vector3(); // NDC coordinates
        this.endPoint = new THREE.Vector3(); // NDC coordinates
        this.collection = []; // Array of intersecting objects
        this.instances = {};
        this.deep = deep; // How far into the scene to select
    }

    /**
     * Performs the selection.
     * @param {THREE.Vector3} startPoint - NDC coordinates
     * @param {THREE.Vector3} endPoint - NDC coordinates
     * @returns {THREE.Object3D[]}
     */
    select(startPoint, endPoint) {
        this.startPoint = startPoint || this.startPoint;
        this.endPoint = endPoint || this.endPoint;
        this.collection = [];

        this._updateFrustum(this.startPoint, this.endPoint);
        this._searchChildInFrustum(_frustum, this.scene);

        return this.collection;
    }

    /**
     * Creates a selection frustum from the camera and 2D start/end points.
     */
    _updateFrustum(startPoint, endPoint) {
        // Ensure non-zero area
        if (startPoint.x === endPoint.x) endPoint.x += Number.EPSILON;
        if (startPoint.y === endPoint.y) endPoint.y += Number.EPSILON;

        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld();

        if (this.camera.isPerspectiveCamera) {
            _tmpPoint.copy(startPoint);
            _tmpPoint.x = Math.min(startPoint.x, endPoint.x);
            _tmpPoint.y = Math.max(startPoint.y, endPoint.y);
            endPoint.x = Math.max(startPoint.x, endPoint.x);
            endPoint.y = Math.min(startPoint.y, endPoint.y);

            _vecNear.setFromMatrixPosition(this.camera.matrixWorld);
            _vecTopLeft.copy(_tmpPoint);
            _vecTopRight.set(endPoint.x, _tmpPoint.y, 0);
            _vecDownRight.copy(endPoint);
            _vecDownLeft.set(_tmpPoint.x, endPoint.y, 0);

            // Unproject 2D points to 3D world space
            _vecTopLeft.unproject(this.camera);
            _vecTopRight.unproject(this.camera);
            _vecDownRight.unproject(this.camera);
            _vecDownLeft.unproject(this.camera);

            _vectemp1.copy(_vecTopLeft).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);
            _vectemp2.copy(_vecTopRight).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);
            _vectemp3.copy(_vecDownRight).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);

            // Define the 6 planes of the frustum
            const planes = _frustum.planes;
            planes[0].setFromCoplanarPoints(_vecNear, _vecTopLeft, _vecTopRight);
            planes[1].setFromCoplanarPoints(_vecNear, _vecTopRight, _vecDownRight);
            planes[2].setFromCoplanarPoints(_vecDownRight, _vecDownLeft, _vecNear);
            planes[3].setFromCoplanarPoints(_vecDownLeft, _vecTopLeft, _vecNear);
            planes[4].setFromCoplanarPoints(_vecTopRight, _vecDownRight, _vecDownLeft);
            planes[5].setFromCoplanarPoints(_vectemp3, _vectemp2, _vectemp1);
            planes[5].normal.multiplyScalar(-1);
        } else if (this.camera.isOrthographicCamera) {
            // ... (Logic for orthographic camera) ...
            const left = Math.min(startPoint.x, endPoint.x);
            const top = Math.max(startPoint.y, endPoint.y);
            const right = Math.max(startPoint.x, endPoint.x);
            const down = Math.min(startPoint.y, endPoint.y);
            _vecTopLeft.set(left, top, -1);
            _vecTopRight.set(right, top, -1);
            _vecDownRight.set(right, down, -1);
            _vecDownLeft.set(left, down, -1);
            _vecFarTopLeft.set(left, top, 1);
            _vecFarTopRight.set(right, top, 1);
            _vecFarDownRight.set(right, down, 1);
            _vecFarDownLeft.set(left, down, 1);
            _vecTopLeft.unproject(this.camera);
            _vecTopRight.unproject(this.camera);
            _vecDownRight.unproject(this.camera);
            _vecDownLeft.unproject(this.camera);
            _vecFarTopLeft.unproject(this.camera);
            _vecFarTopRight.unproject(this.camera);
            _vecFarDownRight.unproject(this.camera);
            _vecFarDownLeft.unproject(this.camera);
            const planes = _frustum.planes;
            planes[0].setFromCoplanarPoints(_vecTopLeft, _vecFarTopLeft, _vecFarTopRight);
            planes[1].setFromCoplanarPoints(_vecTopRight, _vecFarTopRight, _vecFarDownRight);
            planes[2].setFromCoplanarPoints(_vecFarDownRight, _vecFarDownLeft, _vecDownLeft);
            planes[3].setFromCoplanarPoints(_vecFarDownLeft, _vecFarTopLeft, _vecTopLeft);
            planes[4].setFromCoplanarPoints(_vecTopRight, _vecDownRight, _vecDownLeft);
            planes[5].setFromCoplanarPoints(_vecFarDownRight, _vecFarTopRight, _vecFarTopLeft);
            planes[5].normal.multiplyScalar(-1);
        } else {
            console.error('THREE.SelectionBox: Unsupported camera type.');
        }
    }

    /**
     * Recursively search for objects within the frustum.
     */
    _searchChildInFrustum(frustum, object) {
        
        if (object.isMesh || object.isLine || object.isPoints) {
            
            if (object.isInstancedMesh) {
              // ... (Logic for instanced meshes) ...
              this.instances[object.uuid] = [];
              for (let instanceId = 0; instanceId < object.count; instanceId++) {
                object.getMatrixAt(instanceId, _matrix);
                _matrix.decompose(_center, _quaternion, _scale);
                _center.applyMatrix4(object.matrixWorld);
                if (frustum.containsPoint(_center)) {
                  this.instances[object.uuid].push(instanceId);
                }
              }
              if (this.instances[object.uuid].length > 0) {
                this.collection.push(object); 
              }
            } else {
                // Check if object's bounding box intersects the frustum
                if (object.geometry.boundingBox === null) {
                    object.geometry.computeBoundingBox();
                }
                _box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);

                if (frustum.intersectsBox(_box)) {
                    this.collection.push(object);
                }
            }
        }

        // Recurse into children
        for (let i = 0; i < object.children.length; i++) {
            this._searchChildInFrustum(frustum, object.children[i]);
        }
    }
}


/**
 * This class provides a visual helper for {@link SelectionBox}.
 * It renders a 2D box on the screen.
 */
class SelectionHelper {

    constructor(renderer, cssClassName) {
        this.element = document.createElement('div');
        this.element.classList.add(cssClassName);
        this.element.style.pointerEvents = 'none';
        this.renderer = renderer;
        this.isDown = false; // Is selection active
        this.enabled = true;
        this._startPoint = new THREE.Vector2();
        this._pointTopLeft = new THREE.Vector2();
        this._pointBottomRight = new THREE.Vector2();

        /**
         * --- MODIFIED ---
         * This listener now only starts a selection box on LEFT CLICK + SHIFT.
         */
        this._onPointerDown = function (event) {
            
            // Only activate on left-click + shift
            if (this.enabled === false || event.button !== 0 || !event.shiftKey) return;
            
            event.preventDefault();
            this.isDown = true;
            this._onSelectStart(event);

        }.bind(this);

        this._onPointerMove = function (event) {
            if (this.enabled === false) return;
            if (this.isDown) {
                this._onSelectMove(event);
            }
        }.bind(this);

        this._onPointerUp = function () {
            if (this.enabled === false) return;
            
            const wasSelecting = this.isDown;
            this.isDown = false;
            this._onSelectOver(); // Hides the box
            
            // Re-enable orbit controls if we were selecting
            if (wasSelecting) {
                controls.enabled = true;
            }
        }.bind(this);

        // Add listeners to the renderer's DOM element
        this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
        this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
        this.renderer.domElement.addEventListener('pointerup', this._onPointerUp);
    }

    dispose() {
        this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
        this.renderer.domElement.removeEventListener('pointerup', this._onPointerUp);
        this.element.remove();
    }

    /**
     * Called on pointer down (with shift) to start the selection box.
     */
    _onSelectStart(event) {
        this.element.style.display = 'none';
        this.renderer.domElement.parentElement.appendChild(this.element);

        // Set initial position and size
        this.element.style.left = event.clientX + 'px';
        this.element.style.top = event.clientY + 'px';
        this.element.style.width = '0px';
        this.element.style.height = '0px';

        this._startPoint.x = event.clientX;
        this._startPoint.y = event.clientY;
    }

    /**
     * Called on pointer move (while down) to resize the selection box.
     */
    _onSelectMove(event) {
        this.element.style.display = 'block';

        // Calculate top-left and bottom-right corners
        this._pointBottomRight.x = Math.max(this._startPoint.x, event.clientX);
        this._pointBottomRight.y = Math.max(this._startPoint.y, event.clientY);
        this._pointTopLeft.x = Math.min(this._startPoint.x, event.clientX);
        this._pointTopLeft.y = Math.min(this._startPoint.y, event.clientY);

        // Update CSS
        this.element.style.left = this._pointTopLeft.x + 'px';
        this.element.style.top = this._pointTopLeft.y + 'px';
        this.element.style.width = (this._pointBottomRight.x - this._pointTopLeft.x) + 'px';
        this.element.style.height = (this._pointBottomRight.y - this._pointTopLeft.y) + 'px';
        
        // --- LIVE PREVIEW ---
        // Perform selection *during* the drag to update the outline
        selectedObjectsForOutline = performBoxSelection(this._startPoint, new THREE.Vector2(event.clientX, event.clientY));
    }

    /**
     * Called on pointer up to hide the selection box.
     */
    _onSelectOver() {
        this.element.remove();
    }
}