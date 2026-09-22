// SheetJS 体积接近 1MB，仅在打开 Excel/CSV 预览时才需要。
// 按需动态导入，避免拖慢首屏 JS 的下载与解析。
let xlsxImport: Promise<typeof import('xlsx')> | null = null;

export const loadXLSX = () => (xlsxImport ||= import('xlsx'));
