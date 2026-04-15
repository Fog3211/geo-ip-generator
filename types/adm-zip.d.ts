declare module 'adm-zip' {
  export default class AdmZip {
    constructor(filePath: string);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
