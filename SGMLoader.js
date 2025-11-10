
class SGMLoader extends THREE.Loader {
    constructor(manager) {
        super(manager);
    }

   load(file, onLoad, onProgress, onError) {
        // FIX: Check if the 'file' is already a full URL (like a blob)
        // If not, construct the path as before.
        const isFullUrl = file.startsWith('blob:') || file.startsWith('http');
        const url = isFullUrl ? file : this.path + file + '.sgm';

        sgmWorkerPool.run({ fileUrl: url }, (data) => {
            const { status, meshData, materialData, animFilename, error } = data;
if (status === 'error') {
      console.error("SGMLoader skipping missing file:", url, error);
      onLoad({ group: new THREE.Group(), skeleton: null, clips: null }); // fallback empty group
      return;
    }

            const group = this.createGroupFromMeshes(meshData, materialData);

            if (animFilename) {
                const sgaLoader = new SGALoader(this.manager);
                sgaLoader.setPath(this.path);

                const directoryPath = file.match(/^(.*\/)/) ? file.match(/^(.*\/)/)[1] : '';
                const sgaPath = directoryPath + animFilename.replace('*', 'sga');

                sgaLoader.load(
                    sgaPath,
                    (sgaData) => {
                        const { skeleton, clips } = sgaData;
                        group.traverse((child) => {
                            if (child.isSkinnedMesh) {
                                child.bind(skeleton);
                            }
                        });
                        onLoad({ group, skeleton, clips });
                    },
                    onProgress,
                    (err) => {
                        console.warn(`Could not load skeleton from "${sgaPath}". Converting skinned meshes to static meshes.`, err);
                        this.convertSkinnedMeshesToStaticMeshes(group);
                        onLoad({ group, skeleton: null, clips: null });
                    }
                );
            } else {
                onLoad({ group, skeleton: null, clips: null });
            }
        });
    }

    convertSkinnedMeshesToStaticMeshes(group) {
        const meshesToReplace = [];
        
        group.traverse((child) => {
            if (child.isSkinnedMesh) {
                meshesToReplace.push(child);
            }
        });

        meshesToReplace.forEach((skinnedMesh) => {
            const staticMesh = new THREE.Mesh(skinnedMesh.geometry, skinnedMesh.material);
            
            staticMesh.position.copy(skinnedMesh.position);
            staticMesh.rotation.copy(skinnedMesh.rotation);
            staticMesh.scale.copy(skinnedMesh.scale);
            staticMesh.name = skinnedMesh.name;
            staticMesh.userData = skinnedMesh.userData;
            
            const parent = skinnedMesh.parent;
            if (parent) {
                const index = parent.children.indexOf(skinnedMesh);
                parent.remove(skinnedMesh);
                parent.add(staticMesh);
                
                if (index !== -1 && index < parent.children.length - 1) {
                    parent.children.splice(index, 0, parent.children.pop());
                }
            }
        });
    }

    createGroupFromMeshes(meshes, materials) {
        const group = new THREE.Group();
        const threeMaterials = [];

        // Material creation
        for (const material of materials) {
            const color = material.colors?.[0]?.[0] || [1, 1, 1];
            const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().fromArray(color) });
            threeMaterials[material.material_id] = mat;
        }

        // Mesh creation
        for (const mesh of meshes) {
            const geometry = new THREE.BufferGeometry();
            const interleavedBuffer = new THREE.InterleavedBuffer(mesh.interleavedBuffer, mesh.stride);

            for (const name in mesh.attributes) {
                const attr = mesh.attributes[name];
                geometry.setAttribute(
                    name,
                    new THREE.InterleavedBufferAttribute(interleavedBuffer, attr.itemSize, attr.offset)
                );
            }
            
            if (mesh.attributes.color && threeMaterials[mesh.material_id]) {
                threeMaterials[mesh.material_id].vertexColors = true;
            }

            geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
            
            const hasSkinData = mesh.skinWeights && mesh.skinIndices;
            if (hasSkinData) {
                geometry.setAttribute('skinWeight', new THREE.BufferAttribute(mesh.skinWeights, 4));
                geometry.setAttribute('skinIndex', new THREE.BufferAttribute(mesh.skinIndices, 4));
            }

            const material = threeMaterials[mesh.material_id] || new THREE.MeshStandardMaterial();
            let threeMesh;
            
            if (hasSkinData && geometry.attributes.skinWeight && geometry.attributes.skinIndex) {
                threeMesh = new THREE.SkinnedMesh(geometry, material);
                const tempBones = [new THREE.Bone()];
                const tempSkeleton = new THREE.Skeleton(tempBones);
                threeMesh.bind(tempSkeleton);
            } else {
                threeMesh = new THREE.Mesh(geometry, material);
            }

            group.add(threeMesh);
        }

        return group;
    }
}

/**
 * A simple, reusable Worker Pool Manager.
 * This class is unchanged and works correctly with the loader.
 */
class WorkerPool {
    constructor(workerPath, poolSize = 4) {
        this.workers = [];
        this.taskQueue = [];
        this.workerPath = workerPath;

        for (let i = 0; i < poolSize; i++) {
            this.workers.push({ worker: new Worker(this.workerPath), busy: false });
        }
    }

    run(taskData, onComplete) {
        const availableWorker = this.workers.find(w => !w.busy);

        if (availableWorker) {
            this._assignTask(availableWorker, taskData, onComplete);
        } else {
            // All workers are busy, queue the task.
            this.taskQueue.push({ taskData, onComplete });
        }
    }

    _assignTask(workerWrapper, taskData, onComplete) {
        workerWrapper.busy = true;
        
        const messageHandler = (event) => {
            onComplete(event.data);
            
            // Cleanup and check for more tasks.
            workerWrapper.worker.removeEventListener('message', messageHandler);
            workerWrapper.busy = false;
            
            if (this.taskQueue.length > 0) {
                const nextTask = this.taskQueue.shift();
                this._assignTask(workerWrapper, nextTask.taskData, nextTask.onComplete);
            }
        };

        workerWrapper.worker.addEventListener('message', messageHandler);
        workerWrapper.worker.postMessage(taskData);
    }
}