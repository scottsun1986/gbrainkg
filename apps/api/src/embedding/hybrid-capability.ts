export function validateHybridCapability(cap:any, model:string, revision:string, dimensions:number, multi:boolean) {
  if (!revision || cap?.contract!=='bge-m3-representations-v1' || cap.model!==model || cap.revision!==revision || !cap.tokenizerRevision || cap.denseDimensions!==dimensions || cap.sparse!==true || !Number.isInteger(cap.vocabSize) || cap.vocabSize<1 || cap.vocabSize>10000000 || (multi && (cap.multiVector!==true || !Number.isInteger(cap.tokenDimensions) || cap.tokenDimensions<1 || cap.tokenDimensions>1024))) throw new Error('Unverified BGE-M3 sparse/multi-vector capability');
  return cap as { vocabSize:number;tokenDimensions:number;tokenizerRevision:string };
}
