import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';

const baseURL = process.env.LIBRECHAT_CODE_BASEURL;
const privateJwk = process.env.CODEAPI_JWT_PRIVATE_JWK_JSON;
const kid = process.env.CODEAPI_JWT_KID ?? 'sg-local-codeapi-1';

if (!baseURL || !privateJwk) {
  throw new Error('Code API smoke test environment is not configured');
}

const userId = 'sg-codeapi-smoke';
const tenantId = 'local-smoke';
const role = 'USER';
const principalSource = 'librechat_jwt';
const context = {
  chc_user_id: '',
  org_id: '',
  principal_source: principalSource,
  role,
  service_id: '',
  sub: userId,
  tenant_id: tenantId,
};
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'EdDSA', typ: 'JWT', kid };
const claims = {
  iss: 'librechat',
  aud: 'codeapi',
  sub: userId,
  iat: now,
  nbf: now,
  exp: now + 300,
  jti: randomUUID(),
  tenant_id: tenantId,
  role,
  principal_source: principalSource,
  auth_context_hash: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
};
const encode = (value) => Buffer.from(value).toString('base64url');
const signingInput = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(claims))}`;
const signature = cryptoSign(
  null,
  Buffer.from(signingInput),
  createPrivateKey({ key: JSON.parse(privateJwk), format: 'jwk' }),
);
const token = `${signingInput}.${signature.toString('base64url')}`;
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-CodeAPI-Expected-Profile': 'default',
};

const cases = [
  {
    language: 'py',
    marker: 'PYTHON_TOTAL=5050',
    filename: 'python-result.txt',
    fileContent: 'python=5050\n',
    code: [
      'total = sum(range(1, 101))',
      'print(f"PYTHON_TOTAL={total}")',
      'with open("/mnt/data/python-result.txt", "w", encoding="utf-8") as file:',
      '    file.write(f"python={total}\\n")',
    ].join('\n'),
  },
  {
    language: 'js',
    marker: 'JAVASCRIPT_TOTAL=5050',
    filename: 'javascript-result.json',
    fileContent: '{"javascript":5050}\n',
    code: [
      "const fs = require('node:fs');",
      'const total = Array.from({ length: 100 }, (_, index) => index + 1).reduce((sum, value) => sum + value, 0);',
      'console.log(`JAVASCRIPT_TOTAL=${total}`);',
      "fs.writeFileSync('/mnt/data/javascript-result.json', `${JSON.stringify({ javascript: total })}\\n`);",
    ].join('\n'),
  },
  {
    language: 'ts',
    marker: 'TYPESCRIPT_TOTAL=5050',
    filename: 'typescript-result.txt',
    fileContent: 'typescript=5050\n',
    code: [
      "import { writeFileSync } from 'node:fs';",
      'const values: number[] = Array.from({ length: 100 }, (_, index) => index + 1);',
      'const total: number = values.reduce((sum, value) => sum + value, 0);',
      'console.log(`TYPESCRIPT_TOTAL=${total}`);',
      "writeFileSync('/mnt/data/typescript-result.txt', `typescript=${total}\\n`);",
    ].join('\n'),
  },
];

async function execute(testCase) {
  const response = await fetch(`${baseURL}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lang: testCase.language, code: testCase.code, args: [] }),
  });
  const result = await response.json();
  if (!response.ok || !result.stdout?.includes(testCase.marker)) {
    throw new Error(`${testCase.language} execution failed with HTTP ${response.status}`);
  }
  const file = result.files?.find((item) => item.name === testCase.filename);
  if (!file || !result.session_id) {
    throw new Error(`${testCase.language} did not return the expected file`);
  }
  const query = new URLSearchParams({ kind: 'user', id: userId });
  const download = await fetch(
    `${baseURL}/download/${encodeURIComponent(result.session_id)}/${encodeURIComponent(file.id)}?${query}`,
    { headers },
  );
  const content = await download.text();
  if (!download.ok || content !== testCase.fileContent) {
    throw new Error(`${testCase.language} file download verification failed`);
  }
  return {
    language: testCase.language,
    executionStatus: response.status,
    outputMatched: true,
    file: testCase.filename,
    downloadStatus: download.status,
    fileMatched: true,
  };
}

async function verifyKoreanPdf() {
  const filename = 'korean-pdf-result.pdf';
  const code = [
    'import subprocess',
    'from pathlib import Path',
    'from reportlab.pdfbase import pdfmetrics',
    'from reportlab.pdfbase.ttfonts import TTFont',
    'from reportlab.pdfgen import canvas',
    'from reportlab.lib.pagesizes import A4',
    'from PyPDF2 import PdfReader',
    'match = subprocess.run(["fc-match", "-f", "%{file}", "NanumGothic"], capture_output=True, text=True, check=True)',
    'font_path = match.stdout.strip()',
    'assert not match.stderr.strip()',
    'assert font_path and Path(font_path).is_file() and font_path.lower().endswith(".ttf")',
    'pdfmetrics.registerFont(TTFont("SGNanum", font_path))',
    `output = Path("/mnt/data/${filename}")`,
    'document = canvas.Canvas(str(output), pagesize=A4)',
    'document.setFont("SGNanum", 18)',
    'document.drawString(72, 770, "SG AI 한글 PDF 생성 테스트")',
    'document.setFont("SGNanum", 12)',
    'document.drawString(72, 735, "한글 글꼴 포함과 텍스트 추출이 정상입니다.")',
    'document.save()',
    'reader = PdfReader(str(output))',
    'extracted = "".join(page.extract_text() or "" for page in reader.pages)',
    'assert "SG AI 한글 PDF 생성 테스트" in extracted',
    'font_resources = reader.pages[0]["/Resources"]["/Font"]',
    'fonts = [reference.get_object() for reference in font_resources.values()]',
    'descriptors = []',
    'for font in fonts:',
    '    descendants = [reference.get_object() for reference in font.get("/DescendantFonts", [])]',
    '    for candidate in [font, *descendants]:',
    '        descriptor_reference = candidate.get("/FontDescriptor")',
    '        if descriptor_reference:',
    '            descriptors.append(descriptor_reference.get_object())',
    'embedded = any(any(key in descriptor for key in ["/FontFile", "/FontFile2", "/FontFile3"]) for descriptor in descriptors)',
    'assert embedded',
    'print("KOREAN_PDF_OK")',
  ].join('\n');
  const response = await fetch(`${baseURL}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lang: 'py', code, args: [] }),
  });
  const result = await response.json();
  if (!response.ok || !result.stdout?.includes('KOREAN_PDF_OK')) {
    throw new Error(`Korean PDF generation failed with HTTP ${response.status}`);
  }
  const file = result.files?.find((item) => item.name === filename);
  if (!file || !result.session_id) {
    throw new Error('Korean PDF generation did not return the expected file');
  }
  const query = new URLSearchParams({ kind: 'user', id: userId });
  const download = await fetch(
    `${baseURL}/download/${encodeURIComponent(result.session_id)}/${encodeURIComponent(file.id)}?${query}`,
    { headers },
  );
  const content = Buffer.from(await download.arrayBuffer());
  if (!download.ok || content.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Korean PDF download verification failed');
  }
  return {
    executionStatus: response.status,
    fontMatched: true,
    textExtracted: true,
    fontEmbedded: true,
    downloadStatus: download.status,
    pdfMatched: true,
  };
}

const unauthorized = await fetch(`${baseURL}/exec`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lang: 'py', code: 'print(1)' }),
});
if (unauthorized.status !== 401) {
  throw new Error(`Unauthenticated execution was not rejected: HTTP ${unauthorized.status}`);
}

const results = [];
for (const testCase of cases) {
  results.push(await execute(testCase));
}
const koreanPdf = await verifyKoreanPdf();

const errorResponse = await fetch(`${baseURL}/exec`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    lang: 'py',
    code: 'raise ValueError("EXPECTED_CODEAPI_ERROR")',
  }),
});
const errorResult = await errorResponse.json();
if (!JSON.stringify(errorResult).includes('EXPECTED_CODEAPI_ERROR')) {
  throw new Error(`Execution error was not preserved: HTTP ${errorResponse.status}`);
}

const networkResponse = await fetch(`${baseURL}/exec`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    lang: 'py',
    code: [
      'import socket',
      'try:',
      '    socket.create_connection(("example.com", 80), timeout=2)',
      '    print("NETWORK_UNEXPECTED")',
      'except Exception:',
      '    print("NETWORK_BLOCKED")',
    ].join('\n'),
  }),
});
const networkResult = await networkResponse.json();
if (!networkResponse.ok || !networkResult.stdout?.includes('NETWORK_BLOCKED')) {
  throw new Error('Sandbox network isolation verification failed');
}

console.log(
  JSON.stringify({
    unauthorizedStatus: unauthorized.status,
    runtimes: results,
    koreanPdf,
    executionErrorCaptured: true,
    networkBlocked: true,
  }),
);
