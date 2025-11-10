const skyVS = `
	varying vec3 vWorldPosition;

	void main()
	{
		vec3 rotatedPosition = (modelViewMatrix * vec4(position, 0.0)).xyz;
		gl_Position = projectionMatrix * vec4(rotatedPosition, 0.0);
		gl_Position.z = gl_Position.w;

		vWorldPosition = position;
	}`

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
	}`

const levelVS = `
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying vec3 vScaledPosition;

    uniform mat3 worldNormalMatrix;

void main()
{
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    vNormal = worldNormalMatrix * normal;

    // Calculate model scale from model matrix columns
    vec3 modelScale = vec3(
        length(modelMatrix[0].xyz),
        length(modelMatrix[1].xyz),
        length(modelMatrix[2].xyz)
    );
    vScaledPosition = position * modelScale; // Scale local position

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const levelFS = `
    varying vec3 vWorldPosition;
    varying vec3 vScaledPosition; 
    varying vec3 vNormal;

    uniform sampler2D colorTexture;
    uniform float tileFactor;
    uniform vec3 diffuseColor;
    uniform float neonEnabled;
	uniform float transparentEnabled;
    uniform float fogEnabled;
	uniform float isLava;
	uniform float isColoredLava;

    uniform vec2 cameraFogDistance;
    uniform vec3 cameraFogColor0;
	uniform vec3 cameraFogColor1;
	uniform float sunSize;
	uniform vec3 sunColor;
	uniform vec3 sunDirection;
	uniform vec4 specularColor;

    void main()
    {
        vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
		vec4 texColor = vec4(0.0, 0.0, 0.0, 1.0);

        vec3 blendNormals = abs(vNormal);
if(blendNormals.x > blendNormals.y && blendNormals.x > blendNormals.z)
{
    texColor.rgb = texture2D(colorTexture, vScaledPosition.zy * tileFactor).rgb;
}
else if(blendNormals.y > blendNormals.z)
{
    texColor.rgb = texture2D(colorTexture, vScaledPosition.xz * tileFactor).rgb;
}
else
{
    texColor.rgb = texture2D(colorTexture, vScaledPosition.xy * tileFactor).rgb;
}

		color.rgb = texColor.rgb * diffuseColor;

		if (isColoredLava > 0.5) {
			vec3 blendValues = vec3(texColor.b);
			color.rgb = mix(diffuseColor.rgb, specularColor.rgb, blendValues.b);
			color.rgb += blendValues.g * 0.1 - (1.0 - blendValues.r) * 0.2;
		} else if (isLava > 0.5) {
			color.rgb = vec3(color.rg, 0);
		}

        vec3 cameraToVertex = vWorldPosition - cameraPosition;
	    float distanceToCamera = length(cameraToVertex);
	    cameraToVertex = normalize(cameraToVertex);

		if(neonEnabled < 0.5)
		{
			//Apply sun light
	        vec3 lightDirection = normalize(-sunDirection);

	        float light = dot(normalize(vNormal), lightDirection);
	        float finalLight = clamp(light, 0.0, 1.0);
	        float lightFactor = finalLight;
	        lightFactor -= clamp(-light * 0.15, 0.0, 1.0);

			vec3 halfVector = normalize((-sunDirection - cameraToVertex));
			float lightSpecular = clamp(dot(normalize(vNormal), halfVector), 0.0, 1.0);

			color.rgb = 0.5 * color.rgb + sunColor * clamp(sunSize * 0.7 + 0.3, 0.0, 1.0) * (color.rgb * lightFactor + pow(lightSpecular, specularColor.a) * specularColor.rgb * finalLight);
		}

        //Fog
        if(fogEnabled > 0.5)
        {
            float horizonFactor = 1.0 - clamp(abs(cameraToVertex.y) / 0.8, 0.0, 1.0);
            vec3 fogColor = mix(cameraFogColor1.rgb, cameraFogColor0.rgb, horizonFactor * horizonFactor);

            float sunAngle = acos(dot(sunDirection, -cameraToVertex));
            float sunSize_ = 0.05 * sunSize;
            float sunGlowSize = sunSize;
            float sunFactor = clamp((sunGlowSize - sunAngle) / sunGlowSize, 0.0, 1.0);
            sunFactor *= sunFactor;
            fogColor = mix(fogColor, sunColor, sunFactor);

            float fogAmount = clamp((1.0 - exp(-distanceToCamera * cameraFogDistance.x)) * cameraFogDistance.y, 0.0, 1.0);
            color.rgb = mix(color.rgb, fogColor, fogAmount * fogAmount);
        }

		if(transparentEnabled > 0.5) {
			color.a = 0.5;
		}

        gl_FragColor = color;

   		#include <colorspace_fragment>
    }`

const startFinishVS = `
	varying vec2 vTexcoord;
	varying vec3 vWorldPosition;

	void main()
	{
		vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;

		vTexcoord = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`

const startFinishFS = `
	varying vec2 vTexcoord;
	varying vec3 vWorldPosition;

	uniform vec4 diffuseColor;

	uniform float fogEnabled;
    uniform vec2 cameraFogDistance;
    uniform vec3 cameraFogColor0;
	uniform vec3 cameraFogColor1;
	uniform float sunSize;
	uniform vec3 sunColor;
	uniform vec3 sunDirection;

	void main()
	{
		vec4 color = diffuseColor;
		float factor = vTexcoord.y;
		factor *= factor * factor;
		factor = clamp(factor, 0.0, 1.0);
		color.a = factor;

		//Fog
        if(fogEnabled > 0.5)
        {
        	vec3 cameraToVertex = vWorldPosition - cameraPosition;
        	float distanceToCamera = length(cameraToVertex);
        	cameraToVertex = normalize(cameraToVertex);

            float horizonFactor = 1.0 - clamp(abs(cameraToVertex.y) / 0.8, 0.0, 1.0);
            vec3 fogColor = mix(cameraFogColor1.rgb, cameraFogColor0.rgb, horizonFactor * horizonFactor);

            float sunAngle = acos(dot(sunDirection, -cameraToVertex));
            float sunSize_ = 0.05 * sunSize;
            float sunGlowSize = sunSize;
            float sunFactor = clamp((sunGlowSize - sunAngle) / sunGlowSize, 0.0, 1.0);
            sunFactor *= sunFactor;
            fogColor = mix(fogColor, sunColor, sunFactor);

            float fogAmount = clamp((1.0 - exp(-distanceToCamera * cameraFogDistance.x)) * cameraFogDistance.y, 0.0, 1.0);
            color.rgb = mix(color.rgb, fogColor, fogAmount * fogAmount);
        }

		gl_FragColor = color;
	}`

const signVS = `
	varying vec2 vTexcoord;
	varying vec3 vNormal;
	varying vec3 vWorldPosition;

	void main()
	{
		vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;

		vec4 worldNormal = modelMatrix * vec4(normal, 0.0);
		vNormal = worldNormal.xyz;

		vTexcoord = uv;

		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`

const signFS = `
	varying vec2 vTexcoord;
	varying vec3 vNormal;
	varying vec3 vWorldPosition;

	uniform sampler2D colorTexture;

	uniform float fogEnabled;
    uniform vec2 cameraFogDistance;
    uniform vec3 cameraFogColor0;
	uniform vec3 cameraFogColor1;
	uniform float sunSize;
	uniform vec3 sunColor;
	uniform vec3 sunDirection;
	uniform vec4 specularColor;

	void main()
	{
		vec4 color = texture2D(colorTexture, vTexcoord);

		//Apply sun light
        vec3 cameraToVertex = vWorldPosition - cameraPosition;
        float distanceToCamera = length(cameraToVertex);
        cameraToVertex = normalize(cameraToVertex);

        vec3 lightDirection = normalize(-sunDirection);

        float light = dot(normalize(vNormal), lightDirection);
        float finalLight = clamp(light, 0.0, 1.0);
        float lightFactor = finalLight;
        lightFactor -= clamp(-light * 0.15, 0.0, 1.0);

		vec3 halfVector = normalize((-sunDirection - cameraToVertex));
		float lightSpecular = clamp(dot(normalize(vNormal), halfVector), 0.0, 1.0);

		color.rgb = 0.5 * color.rgb + sunColor * clamp(sunSize * 0.7 + 0.3, 0.0, 1.0) * (color.rgb * lightFactor + pow(lightSpecular, specularColor.a) * specularColor.rgb * finalLight);

        //Fog
        if(fogEnabled > 0.5)
        {
            float horizonFactor = 1.0 - clamp(abs(cameraToVertex.y) / 0.8, 0.0, 1.0);
            vec3 fogColor = mix(cameraFogColor1.rgb, cameraFogColor0.rgb, horizonFactor * horizonFactor);

            float sunAngle = acos(dot(sunDirection, -cameraToVertex));
            float sunSize_ = 0.05 * sunSize;
            float sunGlowSize = sunSize;
            float sunFactor = clamp((sunGlowSize - sunAngle) / sunGlowSize, 0.0, 1.0);
            sunFactor *= sunFactor;
            fogColor = mix(fogColor, sunColor, sunFactor);

            float fogAmount = clamp((1.0 - exp(-distanceToCamera * cameraFogDistance.x)) * cameraFogDistance.y, 0.0, 1.0);
            color.rgb = mix(color.rgb, fogColor, fogAmount * fogAmount);
        }

		gl_FragColor = color;
		#include <colorspace_fragment>
	}`
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