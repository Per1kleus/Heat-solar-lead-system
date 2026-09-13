import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { get, run } from './db.ts';
import { loadQuotation } from './quotations.ts';
import { nowIso } from './time.ts';

const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const ACCENT = '#0d9488';

/**
 * Renders a real PDF for a quotation and caches it under data/pdf.
 * Returns the absolute path; the caller streams it.
 */
export async function renderQuotationPdf(orgId: string, quotationId: string): Promise<string> {
  const quote = loadQuotation(orgId, quotationId);
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [orgId]);
  const filePath = path.join(config.pdfDir, `${quotationId}.pdf`);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: {
      Title: `Quotation ${quote.number}`, Author: org.name, Subject: quote.title,
    } });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('finish', () => resolve());
    stream.on('error', reject);

    const currency = quote.currency ?? 'EUR';
    const fmt = (n: number) => new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, minimumFractionDigits: 2,
    }).format(Number(n || 0));
    const pageWidth = doc.page.width - 96;

    // ---- header
    let headerBottom = 48;
    if (org.logo_url && org.logo_url.startsWith('data:image')) {
      try {
        const base64 = org.logo_url.split(',')[1];
        doc.image(Buffer.from(base64, 'base64'), 48, 44, { fit: [130, 46] });
        headerBottom = 96;
      } catch { /* a broken logo must not break the quotation */ }
    } else {
      doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(org.name ?? 'Quotation', 48, 48);
      headerBottom = 74;
    }

    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    const companyLines = [
      org.address, [org.postal_code, org.city].filter(Boolean).join(' '),
      org.phone, org.email, org.website,
      org.vat_number ? `VAT ${org.vat_number}` : null,
    ].filter(Boolean) as string[];
    doc.text(companyLines.join('\n'), 320, 48, { width: pageWidth - 272, align: 'right' });

    const top = Math.max(headerBottom, 48 + companyLines.length * 11) + 14;
    doc.moveTo(48, top).lineTo(doc.page.width - 48, top).strokeColor(LINE).lineWidth(1).stroke();

    // ---- title block
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text('Quotation', 48, top + 22);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`No. ${quote.number}`, 48, top + 50)
      .text(`Date: ${new Date(quote.created_at).toLocaleDateString('en-GB')}`, 48, top + 64)
      .text(`Valid until: ${quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB') : 'n/a'}`, 48, top + 78);

    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PREPARED FOR', 320, top + 22, { width: 227 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
      .text(quote.customer_name, 320, top + 36, { width: 227 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
      [
        quote.lead_company, quote.lead_address,
        [quote.lead_postal_code, quote.lead_city].filter(Boolean).join(' '),
        quote.lead_phone, quote.lead_email,
      ].filter(Boolean).join('\n'),
      320, top + 54, { width: 227 },
    );

    let y = top + 130;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(quote.title, 48, y, { width: pageWidth });
    y = doc.y + 4;
    if (quote.description) {
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(quote.description, 48, y, { width: pageWidth });
      y = doc.y + 8;
    }

    // ---- line items
    const cols = { name: 48, qty: 330, unit: 380, price: 430, total: 500 };
    const drawHead = (atY: number) => {
      doc.rect(48, atY - 4, pageWidth, 20).fill('#f1f5f9');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
      doc.text('DESCRIPTION', cols.name + 6, atY + 2);
      doc.text('QTY', cols.qty, atY + 2, { width: 40, align: 'right' });
      doc.text('UNIT', cols.unit, atY + 2, { width: 40, align: 'right' });
      doc.text('PRICE', cols.price, atY + 2, { width: 60, align: 'right' });
      doc.text('TOTAL', cols.total, atY + 2, { width: 47, align: 'right' });
      return atY + 24;
    };

    y = drawHead(y + 8);
    const included = quote.items.filter((i: any) => !i.is_optional);
    const optional = quote.items.filter((i: any) => i.is_optional);

    const drawRows = (rows: any[]) => {
      for (const item of rows) {
        if (y > doc.page.height - 190) {
          doc.addPage();
          y = drawHead(60);
        }
        doc.font('Helvetica').fontSize(9.5).fillColor(INK)
          .text(item.name, cols.name + 6, y, { width: 270 });
        const nameBottom = doc.y;
        if (item.description) {
          doc.font('Helvetica').fontSize(8).fillColor(MUTED)
            .text(item.description, cols.name + 6, nameBottom + 1, { width: 270 });
        }
        doc.font('Helvetica').fontSize(9.5).fillColor(INK);
        doc.text(String(item.quantity), cols.qty, y, { width: 40, align: 'right' });
        doc.text(item.unit ?? '', cols.unit, y, { width: 40, align: 'right' });
        doc.text(fmt(item.unit_price), cols.price, y, { width: 60, align: 'right' });
        doc.font('Helvetica-Bold').text(fmt(item.line_total), cols.total, y, { width: 47, align: 'right' });
        y = Math.max(doc.y, nameBottom) + 8;
        doc.moveTo(48, y - 4).lineTo(doc.page.width - 48, y - 4).strokeColor(LINE).lineWidth(0.5).stroke();
      }
    };
    drawRows(included);

    // ---- totals
    if (y > doc.page.height - 200) { doc.addPage(); y = 60; }
    const totalsX = 340;
    const totalLine = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5)
        .fillColor(bold ? INK : MUTED)
        .text(label, totalsX, y, { width: 120, align: 'right' });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK)
        .text(value, totalsX + 125, y, { width: 82, align: 'right' });
      y += bold ? 20 : 15;
    };
    y += 8;
    totalLine('Subtotal', fmt(quote.subtotal));
    if (quote.discount_amount > 0) totalLine('Discount', `-${fmt(quote.discount_amount)}`);
    totalLine(`VAT ${quote.vat_rate}%`, fmt(quote.vat_amount));
    doc.moveTo(totalsX, y - 4).lineTo(doc.page.width - 48, y - 4).strokeColor(ACCENT).lineWidth(1.2).stroke();
    y += 4;
    totalLine('Total', fmt(quote.total), true);

    // ---- optional extras
    if (optional.length > 0) {
      y += 14;
      if (y > doc.page.height - 160) { doc.addPage(); y = 60; }
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Optional extras', 48, y);
      y = doc.y + 6;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      for (const item of optional) {
        doc.text(`• ${item.name} — ${item.quantity} ${item.unit ?? ''} — ${fmt(item.line_total)}`, 54, y, {
          width: pageWidth - 12,
        });
        y = doc.y + 3;
      }
      y += 4;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
        .text(`Optional total: ${fmt(quote.optional_total)}`, 48, y);
      y = doc.y + 8;
    }

    // ---- notes and terms
    for (const [heading, text] of [['Notes', quote.notes], ['Terms and conditions', quote.terms]] as const) {
      if (!text) continue;
      if (y > doc.page.height - 140) { doc.addPage(); y = 60; }
      y += 10;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(heading, 48, y);
      y = doc.y + 3;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(text, 48, y, { width: pageWidth });
      y = doc.y;
    }

    // ---- signature + footer on every page
    if (y > doc.page.height - 130) { doc.addPage(); y = 60; }
    y += 26;
    doc.moveTo(48, y).lineTo(220, y).strokeColor(LINE).stroke();
    doc.moveTo(330, y).lineTo(doc.page.width - 48, y).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${org.name}${quote.owner_name ? ` — ${quote.owner_name}` : ''}`, 48, y + 5)
      .text('Customer acceptance (name, date, signature)', 330, y + 5);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
        `${org.name} · ${quote.number} · page ${i + 1} of ${range.count}${org.quote_footer ? ` · ${org.quote_footer}` : ''}`,
        48, doc.page.height - 38, { width: pageWidth, align: 'center' },
      );
    }

    doc.end();
  });

  run('UPDATE quotations SET pdf_path = ? WHERE id = ? AND org_id = ?', [filePath, quotationId, orgId]);
  void nowIso();
  return filePath;
}
