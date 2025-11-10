

class SGMParser {
    constructor() {
        this.textDecoder = new TextDecoder();
    }

    parse(data) {
        const bufferView = new DataView(data);
        let offset = 0;

        
        const readUInt8 = () => bufferView.getUint8(offset++);
        const readUInt16 = () => { const v = bufferView.getUint16(offset, true); offset += 2; return v; };
        const readUInt32 = () => { const v = bufferView.getUint32(offset, true); offset += 4; return v; };
        const readFloat32 = () => { const v = bufferView.getFloat32(offset, true); offset += 4; return v; };
        const readString = () => {
            const len = readUInt16();
            if (offset + len > bufferView.buffer.byteLength) {
                throw new RangeError("Attempting to read a string that extends beyond the buffer length.");
            }
            const bytes = new Uint8Array(bufferView.buffer, offset, len);
            offset += len;
            return this.textDecoder.decode(bytes);
        };

        
        const magic = readUInt32();
        if (magic !== 352658064) {
            throw new Error(`Invalid SGM file: incorrect magic number. Expected 352658064, but got ${magic}`);
        }
        const version = readUInt8();

        
        const numMaterials = readUInt8();
        const materials = [];
        for (let i = 0; i < numMaterials; i++) {
            const materialId = readUInt8();
            const uvCount = readUInt8();
            const uvData = [];
            for (let j = 0; j < uvCount; j++) {
                const imageCount = readUInt8();
                const images = [];
                for (let k = 0; k < imageCount; k++) {
                    const typeHint = readUInt8();
                    const filename = readString().replace('*', 'png');
                    images.push([filename, typeHint]);
                }
                uvData.push(images);
            }
            const colorCount = readUInt8();
            const colors = [];
            for (let j = 0; j < colorCount; j++) {
                const colorId = readUInt8();
                colors.push([new Float32Array([readFloat32(), readFloat32(), readFloat32(), readFloat32()]), colorId]);
            }
            materials.push({ material_id: materialId, uv_data: uvData, colors: colors });
        }

        
        const numMeshes = readUInt8();
        const meshes = [];
        for (let i = 0; i < numMeshes; i++) {
            const meshId = readUInt8();
            const materialId = readUInt8();
            const vertexCount = readUInt32();
            const uvCount = readUInt8();
            const texdataCount = readUInt8();
            const hasTangents = readUInt8();
            const hasBones = readUInt8();

            
            let strideInFloats = 0;
            const attributes = {};
            let currentOffset = 0;

            attributes.position = { offset: currentOffset, itemSize: 3 };
            strideInFloats += 3; currentOffset += 3;

            attributes.normal = { offset: currentOffset, itemSize: 3 };
            strideInFloats += 3; currentOffset += 3;

            
            if (uvCount > 0) {
                 for (let k = 0; k < uvCount; k++) {
                    const attributeName = k === 0 ? 'uv' : `uv${k + 1}`;
                    attributes[attributeName] = { offset: currentOffset, itemSize: 2 };
                    strideInFloats += 2;
                    currentOffset += 2;
                }
            }
            if (texdataCount > 0) {
                attributes.color = { offset: currentOffset, itemSize: 4 };
                strideInFloats += 4; currentOffset += 4;
            }
            if (hasTangents) {
                attributes.tangent = { offset: currentOffset, itemSize: 4 };
                strideInFloats += 4; currentOffset += 4;
            }
            
            if (hasBones) {
                attributes.skinWeight = { offset: currentOffset, itemSize: 4 };
                strideInFloats += 4; currentOffset += 4;

                attributes.skinIndex = { offset: currentOffset, itemSize: 4 };
                strideInFloats += 4; currentOffset += 4;
            }

            
            const interleavedArray = new Float32Array(vertexCount * strideInFloats);

            
            for (let j = 0; j < vertexCount; j++) {
                const interleavedBaseIndex = j * strideInFloats;
                let currentInterleavedOffset = 0;

                
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 

                
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 

                
                for (let k = 0; k < uvCount; k++) {
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                }
                
                
                if (texdataCount > 0) {
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                }
                
                
                if (hasTangents) {
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32(); 
                }

                
                if (hasBones) {
                    
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    
                    
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                    interleavedArray[interleavedBaseIndex + currentInterleavedOffset++] = readFloat32();
                }
            }

            
            const indexCount = readUInt32();
            const indexSize = readUInt8();
            const indices = indexSize === 4 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
            for (let j = 0; j < indexCount; j++) {
                indices[j] = indexSize === 4 ? readUInt32() : readUInt16();
            }

            
            meshes.push({
                mesh_id: meshId,
                material_id: materialId,
                interleavedBuffer: interleavedArray,
                indices: indices,
                stride: strideInFloats,
                attributes: attributes,
            });
        }

        const hasAnimation = readUInt8();
        const animFilename = hasAnimation === 1 ? readString() : null;

        return [meshes, materials, animFilename];
    }
}

self.onmessage = async (event) => {
    const { fileUrl } = event.data;
    const parser = new SGMParser();

    try {
        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch SGM file: ${response.status} ${response.statusText}, URL: ${fileUrl}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const [parsedMeshes, materials, animFilename] = parser.parse(arrayBuffer);

        const meshDataForMainThread = [];
        const transferableObjects = [];

        for (const parsedMesh of parsedMeshes) {
            
            const meshPayload = {
                mesh_id: parsedMesh.mesh_id,
                material_id: parsedMesh.material_id,
                stride: parsedMesh.stride,
                attributes: parsedMesh.attributes,
                interleavedBuffer: parsedMesh.interleavedBuffer,
                indices: parsedMesh.indices,
            };
            
            meshDataForMainThread.push(meshPayload);
            
            
            transferableObjects.push(parsedMesh.interleavedBuffer.buffer, parsedMesh.indices.buffer);
        }

        self.postMessage({
            status: 'success',
            meshData: meshDataForMainThread,
            materialData: materials,
            animFilename: animFilename
        }, transferableObjects);

    } catch (error) {
        console.error('Error in SGM Worker:', error);
        self.postMessage({
            status: 'error',
            error: error.message,
            fileUrl: fileUrl
        });
    }
};