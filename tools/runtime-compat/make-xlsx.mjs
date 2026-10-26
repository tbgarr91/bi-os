// Writes a SYNTHETIC two-row workbook to the path given as argv[2]. No real data.
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Sales");
ws.addRow(["order", "amount"]);
ws.addRow(["A1", 50.99]);
ws.addRow(["A2", 22.66]);
writeFileSync(process.argv[2], Buffer.from(await wb.xlsx.writeBuffer()));
