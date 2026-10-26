import Papa from "papaparse";
import readXlsxFile from "read-excel-file/web-worker";
import ExcelJS from "exceljs";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const out = {};
    try {
      const csv = "order,amount\nA1,50.99\nA2,22.66\n";
      const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
      out.papaparse = { ok: parsed.errors.length === 0, rows: parsed.data.length };
    } catch (e) { out.papaparse = { ok: false, error: String(e) }; }
    if (request.method === "POST") {
      const buf = await request.arrayBuffer();
      try {
        const rows = await readXlsxFile(new Blob([buf]));
        out.readExcelFile = { ok: true, rows: rows.length, first: rows[0] };
      } catch (e) { out.readExcelFile = { ok: false, error: String(e).slice(0, 200) }; }
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        out.exceljs = { ok: true, rows: ws.rowCount };
      } catch (e) { out.exceljs = { ok: false, error: String(e).slice(0, 200) }; }
    }
    return Response.json(out);
  },
};
