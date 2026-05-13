export type ViolationRow = {
  asin: string;
  titulo: string;
  marca: string;
  pais: string;
  vendedor: string | null;
  vendedor_nombre: string | null;
  precio: number | null;
};

type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendViolationAlert(
  violations: ViolationRow[],
  resendApiKey: string,
  recipientEmail: string
): Promise<SendResult> {
  const html = buildHtml(violations);
  const subject =
    violations.length === 1
      ? `[BuyBox] 1 violación de exclusiva detectada`
      : `[BuyBox] ${violations.length} violaciones de exclusiva detectadas`;

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "BuyBox Monitor <onboarding@resend.dev>",
        to: [recipientEmail],
        subject,
        html,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Resend API ${res.status}: ${text.slice(0, 300)}` };
  }

  const data = (await res.json()) as { id?: string };
  return { ok: true, id: data.id ?? "unknown" };
}

function buildHtml(violations: ViolationRow[]): string {
  const sorted = [...violations].sort((a, b) => {
    const order = ["ES", "FR", "IT", "DE"];
    const ca = order.indexOf(a.pais);
    const cb = order.indexOf(b.pais);
    if (ca !== cb) return ca - cb;
    const ma = a.marca.toLowerCase();
    const mb = b.marca.toLowerCase();
    if (ma !== mb) return ma.localeCompare(mb);
    return a.asin.localeCompare(b.asin);
  });

  const rows = sorted.map((v) => {
    const seller = v.vendedor_nombre
      ? `${escapeHtml(v.vendedor_nombre)}<br><small style="color:#999;font-size:11px">${v.vendedor ?? ""}</small>`
      : v.vendedor ?? "—";
    const precio = v.precio != null ? `€${v.precio.toFixed(2)}` : "—";
    const domain = { ES: "es", FR: "fr", IT: "it", DE: "de" }[v.pais] ?? "es";
    const url = `https://www.amazon.${domain}/dp/${v.asin}`;
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">
          <a href="${url}" style="color:#0066c0;text-decoration:none;font-family:monospace">${v.asin}</a>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;max-width:280px;font-size:13px">${escapeHtml(v.titulo)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${escapeHtml(v.marca)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">
          <span style="background:#e8f0fe;color:#1a73e8;padding:2px 8px;border-radius:12px;font-weight:700;font-size:12px">${v.pais}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">${seller}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${precio}</td>
      </tr>`;
  }).join("\n");

  const now = new Date().toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "short",
  });

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:920px;margin:0 auto;padding:20px">
  <h2 style="color:#c0392b;border-bottom:2px solid #c0392b;padding-bottom:8px">
    ⚠️ ${violations.length} violaci${violations.length === 1 ? "ón" : "ones"} de exclusiva BuyBox
  </h2>
  <p style="color:#666;margin-bottom:20px">Detectado el <strong>${now}</strong> · Ronda completa (~385 ASINs revisados)</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #ddd">ASIN</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #ddd">Título</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #ddd">Marca</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #ddd">País</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #ddd">Vendedor actual</th>
        <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #ddd">Precio</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p style="font-size:12px;color:#999;margin-top:24px">
    BuyBox Monitor · Zococity — este email se envía una vez al día cuando se detectan violaciones de exclusiva.
  </p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
