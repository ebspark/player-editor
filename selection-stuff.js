


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastClickTime = 0;
let lastSelectedPart = null;
const DOUBLE_CLICK_DELAY = 300; 
let pointerDownStart = null;
const CLICK_DRAG_THRESHOLD = 5; 
let lastSelectedPlayerRoot = null; 

let previewedObjects = [];

const _box = new THREE.Box3();

/**
 * Handles clicks to select scene objects.
 * - Single-click (item): Selects the item.
 * - Single-click (player cosmetic): Selects the cosmetic part.
 * - Double-click (player cosmetic): Selects the whole player.
 * - Click (empty space): Deselects.
 */
function isFromTransformControls(obj) {
    while (obj) {
        if (obj === transformControls) return true;
        obj = obj.parent;
    }
    return false;
}

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
  
  if (multiSelectGroup) {
    
    if (transformControls.object === multiSelectGroup) {
      transformControls.detach();
    }

    
    while (multiSelectGroup.children.length > 0) {
      scene.attach(multiSelectGroup.children[0]);
    }

    scene.remove(multiSelectGroup);
    multiSelectGroup = null;
    
  }

  
  if (transformControls.object) {
    transformControls.detach();
  }

  
  selectedObjectsForOutline = [];
  selectedPlayer = null;
  lastSelectedPart = null;
  lastSelectedPlayerRoot = null;
  
  
  if (window.updateJsonEditorContent) {
    window.updateJsonEditorContent(selectedObjectsForOutline);
  }


  
  if (window.updateAttachmentPreview) {
    window.updateAttachmentPreview(null);
  }
}
function performBoxSelection(startPoint, endPoint) {
    
    
    const rect = renderer.domElement.getBoundingClientRect();

    
    
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
    

    
   const allHitObjects = selectionBox.select(start, end);
    
    const filteredHits = allHitObjects.filter(h => !isFromTransformControls(h) && !h.userData.ignoreInRaycast);

    const finalSelections = new Set();

    filteredHits.forEach(hit => {
        let selectablePart = hit;
        while (selectablePart.parent && selectablePart.parent !== scene) {
            if (selectablePart.parent.userData.isPlayer) {
                break;
            }
            if (selectablePart.userData.isSelectableItem) {
                break;
            }
            selectablePart = selectablePart.parent;
        }
        finalSelections.add(selectablePart);
    });

    return Array.from(finalSelections);
}


function executeSingleClick(event) {
  if (transformControls.dragging) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);

  
  const hits = raycaster
    .intersectObjects(scene.children, true)
    .filter(h => !isFromTransformControls(h.object) && !h.object.userData.ignoreInRaycast);

  if (hits.length === 0) {
    ungroupAndDeselect();
    return;
  }

  const firstHit = hits[0].object;

  let cosmeticPart = null;
  let playerRoot = null;
  let cur = firstHit;
  while (cur && cur !== scene) {
    if (!cosmeticPart && cur.userData?.isItem) { 
      cosmeticPart = cur;
    }
    if (cur.userData?.isPlayer) {
      playerRoot = cur;
      break; 
    }
    cur = cur.parent;
  }

  const now = performance.now();
  const isDoubleClick =
    playerRoot &&
    lastSelectedPlayerRoot === playerRoot &&
    (now - lastClickTime) < DOUBLE_CLICK_DELAY;

  
  let objectToAttach = null;
  if (playerRoot && isDoubleClick) {
    
    objectToAttach = playerRoot;
  } else if (cosmeticPart) {
    
    objectToAttach = cosmeticPart;
  } else {
    
    let obj = firstHit;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    objectToAttach = obj;
  }

  if (objectToAttach) {
    
    if (objectToAttach !== transformControls.object) {
      ungroupAndDeselect();
      transformControls.attach(objectToAttach);
    }
    
    selectedObjectsForOutline = [objectToAttach];

    
    if (window.updateJsonEditorContent) {
      window.updateJsonEditorContent(selectedObjectsForOutline);
    }

    
    
    if (window.updateAttachmentPreview) {
        window.updateAttachmentPreview(objectToAttach);
    }
    
    
    
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

  
  lastClickTime = now;
  lastSelectedPart = cosmeticPart || null;
  lastSelectedPlayerRoot = playerRoot || null;
}

function onPointerDownManager(event) {
    
    if (event.button !== 0 || event.shiftKey) {
        pointerDownStart = null;
        return;
    }
    if (transformControls.dragging) return;
    pointerDownStart = { x: event.clientX, y: event.clientY };
}

function onPointerMoveManager(event) {
    if (!pointerDownStart) return;
    const dist = Math.hypot(event.clientX - pointerDownStart.x, event.clientY - pointerDownStart.y);
    if (dist > CLICK_DRAG_THRESHOLD) {
        
        pointerDownStart = null;
    }
}

/**
 * --- NEW ---
 * Listener for pointerup. If it was a short, quick click (not a drag),
 * we execute the selection logic.
 */
/**
 * Master pointer up handler that determines if the action was a single click
 * or the end of a box selection.
 */
function onPointerUp(event) {
    const dragThreshold = 5;
    const startPoint = selectionHelper._startPoint;
    const endPoint = new THREE.Vector2(event.clientX, event.clientY);

    if (selectionHelper.isDown && startPoint.distanceTo(endPoint) > dragThreshold) {
        
        transformControls.detach();

        const selectedParents = performBoxSelection(startPoint, endPoint);

        ungroupAndDeselect(); 

        if (selectedParents.length === 1) {
            transformControls.attach(selectedParents[0]);
            selectedObjectsForOutline = selectedParents;
            
            if (window.updateAttachmentPreview) {
                window.updateAttachmentPreview(selectedParents[0]);
            }
        } else if (selectedParents.length > 1) {
            multiSelectGroup = new THREE.Group();
            scene.add(multiSelectGroup);
            selectedParents.forEach(p => multiSelectGroup.attach(p));
            transformControls.attach(multiSelectGroup);
            selectedObjectsForOutline = selectedParents;
            
            
        }

        
        if (window.updateJsonEditorContent) {
          window.updateJsonEditorContent(selectedObjectsForOutline);
        }

        
        selectionHelper.isDown = false;
        selectionHelper._onSelectOver();
        controls.enabled = true;
        return;
    }

    
    if (!pointerDownStart) return;
    const dist = Math.hypot(event.clientX - pointerDownStart.x, event.clientY - pointerDownStart.y);
    pointerDownStart = null;
    if (dist <= dragThreshold) {
        selectedObjectsForOutline = [];
        executeSingleClick(event); 
    }
}


/**
 * Initializes the selection system by adding the event listener.
 */
function initializeSelection() {
    renderer.domElement.addEventListener('pointerdown', onPointerDownManager, false);
    renderer.domElement.addEventListener('pointermove', onPointerMoveManager, false);
    renderer.domElement.addEventListener('pointerup', onPointerUp, false);
}

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
 * It is recommended to visualize the selected area with the help of {@link SelectionHelper}.
 *
 * ```js
 * const selectionBox = new SelectionBox( camera, scene );
 * const selectedObjects = selectionBox.select( startPoint, endPoint );
 * ```
 *
 * @three_import import { SelectionBox } from 'three/addons/interactive/SelectionBox.js';
 */
class SelectionBox {
    constructor(camera, scene, deep = Number.MAX_VALUE) {
        this.camera = camera;
        this.scene = scene;
        this.startPoint = new THREE.Vector3();
        this.endPoint = new THREE.Vector3();
        this.collection = [];
        this.instances = {};
        this.deep = deep;
    }

    select(startPoint, endPoint) {
        this.startPoint = startPoint || this.startPoint;
        this.endPoint = endPoint || this.endPoint;
        this.collection = [];

        this._updateFrustum(this.startPoint, this.endPoint);
        this._searchChildInFrustum(_frustum, this.scene);

        return this.collection;
    }

    _updateFrustum(startPoint, endPoint) {
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

            _vecTopLeft.unproject(this.camera);
            _vecTopRight.unproject(this.camera);
            _vecDownRight.unproject(this.camera);
            _vecDownLeft.unproject(this.camera);

            _vectemp1.copy(_vecTopLeft).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);
            _vectemp2.copy(_vecTopRight).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);
            _vectemp3.copy(_vecDownRight).sub(_vecNear).normalize().multiplyScalar(this.deep).add(_vecNear);

            const planes = _frustum.planes;
            planes[0].setFromCoplanarPoints(_vecNear, _vecTopLeft, _vecTopRight);
            planes[1].setFromCoplanarPoints(_vecNear, _vecTopRight, _vecDownRight);
            planes[2].setFromCoplanarPoints(_vecDownRight, _vecDownLeft, _vecNear);
            planes[3].setFromCoplanarPoints(_vecDownLeft, _vecTopLeft, _vecNear);
            planes[4].setFromCoplanarPoints(_vecTopRight, _vecDownRight, _vecDownLeft);
            planes[5].setFromCoplanarPoints(_vectemp3, _vectemp2, _vectemp1);
            planes[5].normal.multiplyScalar(-1);
        } else if (this.camera.isOrthographicCamera) {
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

    
    _searchChildInFrustum(frustum, object) {
        
        if (object.isMesh || object.isLine || object.isPoints) {

            
            if (object.isInstancedMesh) {
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
}
 else {
                
                
                if (object.geometry.boundingBox === null) {
                    object.geometry.computeBoundingBox();
                }
                
                _box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);

                
                if (frustum.intersectsBox(_box)) {
                    this.collection.push(object);
                }
            }
        }

        
        for (let i = 0; i < object.children.length; i++) {
            this._searchChildInFrustum(frustum, object.children[i]);
        }
    }
}



class SelectionHelper {

    constructor(renderer, cssClassName) {

        this.element = document.createElement('div');

        this.element.classList.add(cssClassName);

        this.element.style.pointerEvents = 'none';

        this.renderer = renderer;

        this.isDown = false;

        this.enabled = true;

        this._startPoint = new THREE.Vector2();

        this._pointTopLeft = new THREE.Vector2();

        this._pointBottomRight = new THREE.Vector2();


        /**

         * --- MODIFIED ---

         * This listener now only starts a selection box on LEFT CLICK + SHIFT.

         */

        this._onPointerDown = function (event) {

            

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

            this._onSelectOver();



            

            

            

            if (wasSelecting) {

                controls.enabled = true;

            }

        }.bind(this);


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



    


    _onSelectStart(event) {


        this.element.style.display = 'none';


        this.renderer.domElement.parentElement.appendChild(this.element);


        this.element.style.left = event.clientX + 'px';

        this.element.style.top = event.clientY + 'px';

        this.element.style.width = '0px';

        this.element.style.height = '0px';


        this._startPoint.x = event.clientX;

        this._startPoint.y = event.clientY;


    }


    _onSelectMove(event) {


        this.element.style.display = 'block';


        this._pointBottomRight.x = Math.max(this._startPoint.x, event.clientX);

        this._pointBottomRight.y = Math.max(this._startPoint.y, event.clientY);

        this._pointTopLeft.x = Math.min(this._startPoint.x, event.clientX);

        this._pointTopLeft.y = Math.min(this._startPoint.y, event.clientY);


        this.element.style.left = this._pointTopLeft.x + 'px';

        this.element.style.top = this._pointTopLeft.y + 'px';

        this.element.style.width = (this._pointBottomRight.x - this._pointTopLeft.x) + 'px';

        this.element.style.height = (this._pointBottomRight.y - this._pointTopLeft.y) + 'px';
        selectedObjectsForOutline = performBoxSelection(this._startPoint, new THREE.Vector2(event.clientX, event.clientY));

    }


    _onSelectOver() {


        this.element.remove();


    }


}

