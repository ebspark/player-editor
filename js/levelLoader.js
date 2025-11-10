class LevelLoader {
    constructor(scene) {
        this.scene = scene;
        this.loader = new THREE.GLTFLoader();
        this.textureLoader = new THREE.TextureLoader();
        this.sunDirection = new THREE.Vector3();
        this.skyMaterial = null;
        this.skyMesh = null;
        this.startOffset = new THREE.Vector3(); // Add this line
    }

    async loadLevel(arrayBuffer) {
        try {
            const root = await protobuf.load('/proto/level.proto');
            const Level = root.lookupType('COD.Level.Level');
            const levelData = Level.decode(new Uint8Array(arrayBuffer));

            this.startOffset.set(0, 0, 0);

            let foundStart = false;
            for (const node of levelData.levelNodes) {
                if (node.levelNodeStart) { 
                    const pos = node.levelNodeStart.position;
                    this.startOffset.set(-pos.x, pos.y + 1.4, -pos.z);
                    foundStart = true;
                    break;
                }
            }

            // Initialize default ambience settings
            const ambienceSettings = levelData.ambienceSettings || {
                skyZenithColor: { r: 40, g: 120, b: 180 },
                skyHorizonColor: { r: 230, g: 240, b: 255 },
                sunAltitude: 45,
                sunAzimuth: 180,
                fogDensity: 0.001,
                sunSize: 1.0
            };

            this.applyAmbience(ambienceSettings);

            const loadPromises = levelData.levelNodes.map(node =>
                this.addNode(node)
            );
            await Promise.all(loadPromises);

        } catch (error) {
            console.error('Level loading failed:', error);
        }
    }

    applyAmbience(settings) {

        if (!this.skyMaterial) {
            this.skyMaterial = new THREE.ShaderMaterial({
                vertexShader: skyVS,
                fragmentShader: skyFS,
                side: THREE.BackSide,
                uniforms: {
                    cameraFogColor0: { value: new THREE.Color() },
                    cameraFogColor1: { value: new THREE.Color() },
                    sunDirection: { value: new THREE.Vector3() },
                    sunColor: { value: new THREE.Color() },
                    sunSize: { value: 1.0 },
                    fogDensity: { value: 1.0 },
                    cameraFogDistance: {value: new THREE.Vector2()}
                }
            });
        }

        const horizonColor = new THREE.Color(
            settings.skyHorizonColor.r,
            settings.skyHorizonColor.g,
            settings.skyHorizonColor.b
        );

        const zenithColor = new THREE.Color(
            settings.skyZenithColor.r,
            settings.skyZenithColor.g,
            settings.skyZenithColor.b
        );

        // Calculate sun direction
        const sunAngle = new THREE.Euler(
            THREE.MathUtils.degToRad(settings.sunAltitude),
            THREE.MathUtils.degToRad(settings.sunAzimuth),
            0,
            'XYZ'
        );
        this.sunDirection.set(0, 0, 1).applyEuler(sunAngle).normalize();


        let sunColorFactor = 1.0 - (settings.sunAltitude / 90.0);
        sunColorFactor *= sunColorFactor; 
        sunColorFactor = 1.0 - sunColorFactor;
        sunColorFactor *= 0.8;
        sunColorFactor += 0.2;
    
        const sunColor = new THREE.Color(
            horizonColor.r * (1.0 - sunColorFactor) + sunColorFactor,
            horizonColor.g * (1.0 - sunColorFactor) + sunColorFactor,
            horizonColor.b * (1.0 - sunColorFactor) + sunColorFactor
        );
    
        this.skyMaterial.uniforms.sunColor.value.copy(sunColor);
        this.skyMaterial.uniforms.fogDensity.value = settings.fogDensity;


        let density = settings.fogDensity;
        let densityFactor = density * density * density * density;
        this.fogDensityX = 0.5 * densityFactor + 0.000001 * (1.0 - densityFactor);
        this.fogDensityY = 1.0 / (1.0 - Math.exp(-1500.0 * this.fogDensityX));
    
        this.skyMaterial.uniforms.cameraFogDistance.value = new THREE.Vector2(this.fogDensityX, this.fogDensityY);
        this.skyMaterial.uniforms.cameraFogColor0.value.copy(horizonColor);
        this.skyMaterial.uniforms.cameraFogColor1.value.copy(zenithColor);
        this.skyMaterial.uniforms.sunDirection.value.copy(this.sunDirection);
        this.skyMaterial.uniforms.sunSize.value = settings.sunSize;

       
    if (!this.skyMesh) {
        this.skyMesh = new THREE.Mesh(
            new THREE.SphereGeometry(10000, 32, 32),
            this.skyMaterial
        );
        this.skyMesh.frustumCulled = false
        this.skyMesh.renderOrder = 1000 
        this.scene.add(this.skyMesh);
    }
    }

    createMaterial(staticNode) {
        const texturePath = `/textures/${this.getMaterialName(staticNode.material).toLowerCase()}.png`;
        const texture = this.textureLoader.load(texturePath, undefined, undefined, (err) => {
            console.error('Failed to load texture:', texturePath, err);
        });
    
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(this.getTileFactor(staticNode.material), this.getTileFactor(staticNode.material));
    
        const material = new THREE.ShaderMaterial({
            vertexShader: levelVS,
            fragmentShader: levelFS,
            uniforms: {
                colorTexture: { value: texture },
                tileFactor: { value: 1 },
                uvOffset: { value: new THREE.Vector2(0, 0) },
                diffuseColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
                specularColor: { value: new THREE.Vector4(1, 1, 1, 32) },
                sunDirection: { value: this.sunDirection.clone() },
                sunColor: { value: new THREE.Color(1, 1, 1) },
                cameraFogColor0: { value: this.skyMaterial.uniforms.cameraFogColor0.value },
                cameraFogColor1: { value: this.skyMaterial.uniforms.cameraFogColor1.value },
                sunSize: { value: this.skyMaterial.uniforms.sunSize.value },
                worldNormalMatrix: { value: new THREE.Matrix3() },
                transparentEnabled: { value: 0 },
                isLava: { value: 0 },
                isColoredLava: { value: 0 },
                cameraFogDistance: { value: new THREE.Vector2(this.fogDensityX, this.fogDensityY) },
                fogEnabled: { value: 1 } // Critical fix: Enable fog
            }
        });
        material.uniforms.colorTexture.value.colorSpace = THREE.SRGBColorSpace;
    
        return material;
    }

    configureMaterial(material, staticNode) {
        if (staticNode.color1) {
            material.uniforms.diffuseColor.value.set(
                staticNode.color1.r,
                staticNode.color1.g,
                staticNode.color1.b
            );

            let specularFactor = Math.sqrt(staticNode.color1.r * staticNode.color1.r + staticNode.color1.g * staticNode.color1.g + staticNode.color1.b * staticNode.color1.b) * 0.15;
            let specularColor = [specularFactor, specularFactor, specularFactor, 16.0];
            if (staticNode.color2) {
                material.uniforms.isColoredLava.value = 1;
                specularColor = [staticNode.color2.r, staticNode.color2.g, staticNode.color2.b, staticNode.color2.a];
                material.uniforms.isColoredLava.value = 1.0;
            }
            material.uniforms.specularColor.value = specularColor;
        }
        material.uniforms.tileFactor.value = this.getTileFactor(staticNode.material);

        if (staticNode.isTransparent) {
            material.transparent = true;
            material.uniforms.transparentEnabled.value = 1;
        }

        if (staticNode.material === 3) { 
            material.uniforms.isLava.value = 1;
        }
    }

    getModelName(shape) {
        switch (shape) {
            case 1000: return 'cube.gltf';
            case 1001: return 'sphere.gltf';
            case 1002: return 'cylinder.gltf';
            case 1003: return 'pyramid.gltf';
            case 1004: return 'prism.gltf';
            case 1005: return 'cone.gltf';
            default: return 'cube.gltf';
        }
    }

    getMaterialName(material) {
        switch (material) {
            case 0: return 'DEFAULT';
            case 1: return 'GRABBABLE';
            case 2: return 'ICE';
            case 3: return 'LAVA';
            case 4: return 'WOOD';
            case 5: return 'GRAPPLABLE';
            case 6: return 'GRAPPLABLE_LAVA';
            case 7: return 'GRABBABLE_CRUMBLING';
            case 8: return 'DEFAULT_COLORED';
            case 9: return 'BOUNCING';
            case 10: return 'SNOW';
            default: return 'DEFAULT';
        }
    }
    getTileFactor(material) {
        switch (material) {
            case 0: return 1.0;
            case 1: return 1.0;
            case 2: return 0.1;
            case 3: return 0.1;
            case 4: return 1;
            case 5: return 0.1;
            case 6: return 0.1;
            case 7: return 1;
            case 8: return 1;
            case 9: return 1;
            case 10: return 0.1;
            default: return 1;
        }
    }

    async addNode(node, parent = null) {
        try {
            if (node.levelNodeStatic) {
                await this.addStaticNode(node.levelNodeStatic, parent);
            } else if (node.levelNodeGroup) {
                await this.addGroupNode(node.levelNodeGroup, parent);
            } else if (node.levelNodeStart) { // Handle start node
                await this.addStartNode(node.levelNodeStart, parent);
            }
        } catch (error) {
            console.error('Error loading node:', error);
        }
    }

    async addStartNode(startNode, parent) {
        return new Promise((resolve, reject) => {
            this.loader.load('./models/start_end.gltf', (gltf) => { 
                const model = gltf.scene;

                model.position.set(
                    -startNode.position.x - this.startOffset.x,
                    startNode.position.y - this.startOffset.y,
                    -startNode.position.z - this.startOffset.z
                );


                (parent || this.scene).add(model);
                resolve();
            });
        });
    }


    async addGroupNode(groupNode, parent) {
        const group = new THREE.Group();

        group.position.set(
            -groupNode.position.x,
            groupNode.position.y,
            -groupNode.position.z
        );
        group.quaternion.set(
            -groupNode.rotation.x,
            groupNode.rotation.y,
            -groupNode.rotation.z,
            groupNode.rotation.w
        );
        group.scale.copy(groupNode.scale);

        await Promise.all(
            groupNode.childNodes.map(child =>
                this.addNode(child, group)
            )
        );

        (parent || this.scene).add(group);
    }



    applyMaterial(model, staticNode) {
        const material = this.createMaterial(staticNode);
        model.traverse(child => {
            if (child.isMesh) {
                child.material = material.clone();
                this.configureMaterial(child.material, staticNode);
            }
        });
    }
    async addStaticNode(staticNode, parent) {
        return new Promise((resolve, reject) => {
            this.loader.load(`./models/${this.getModelName(staticNode.shape)}`, (gltf) => {
                const model = gltf.scene;

                model.position.set(
                    -staticNode.position.x - this.startOffset.x,
                    staticNode.position.y - this.startOffset.y,
                    -staticNode.position.z - this.startOffset.z
                );
                model.scale.copy(staticNode.scale);
                model.quaternion.set(-staticNode.rotation.x, staticNode.rotation.y, -staticNode.rotation.z, staticNode.rotation.w);

                model.traverse(child => {
                    if (child.isMesh && child.material instanceof THREE.ShaderMaterial) {
                        const worldMatrix = new THREE.Matrix4();
                        worldMatrix.multiplyMatrices(
                            child.matrixWorld,
                            child.parent.matrixWorld
                        );

                        const normalMatrix = new THREE.Matrix3();
                        normalMatrix.getNormalMatrix(worldMatrix);

                        if (child.material.uniforms.worldNormalMatrix) {
                            child.material.uniforms.worldNormalMatrix.value.copy(normalMatrix);
                        }
                    }
                });

                this.applyMaterial(model, staticNode);
                (parent || this.scene).add(model);
                resolve();
            });
        });
    }
}