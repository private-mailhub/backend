import type { ParsedMail } from 'mailparser';
function escapeHtml(text: string): string {
  const chars: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (c) => chars[c]);
}
export function forwardedBody(
  originalSenderAddress: string,
  relayEmailAddress: string,
  mail: ParsedMail,
  appName: string,
  appDomain: string,
): string {
  const htmlHeader = `
        <div style="max-width: 100%; margin: 0 0 20px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; padding: 1px; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.15);">
            <div style="background-color: #ffffff; border-radius: 7px; padding: 12px 16px;">
              <!-- From and To info -->
              <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
                <div style="display: inline-flex; align-items: center; background: linear-gradient(135deg, #f0f4ff 0%, #e8eeff 100%); padding: 4px 10px; border-radius: 6px; font-size: 12px;">
                  <span style="color: #667eea; margin-right: 4px;">▸</span>
                  <span style="color: #4a5568; font-weight: 600;">From:</span>
                  <span style="color: #2d3748; margin-left: 6px; font-weight: 500;">${escapeHtml(originalSenderAddress)}</span>
                </div>
                <div style="display: inline-flex; align-items: center; background: linear-gradient(135deg, #f0f4ff 0%, #e8eeff 100%); padding: 4px 10px; border-radius: 6px; font-size: 12px;">
                  <span style="color: #667eea; margin-right: 4px;">▸</span>
                  <span style="color: #4a5568; font-weight: 600;">To:</span>
                  <span style="color: #2d3748; margin-left: 6px; font-weight: 500;">${escapeHtml(relayEmailAddress || '')}</span>
                </div>
              </div>

              <!-- Footer with link -->
              <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 8px; border-top: 1px solid #e2e8f0;">
                <div style="font-size: 11px; color: #a0aec0;">
                  <span style="opacity: 0.7;">🔒 forwarded by</span>
                  <a href="https://${appDomain}" style="color: #667eea; text-decoration: none; font-weight: 600; margin-left: 4px; transition: color 0.2s;" target="_blank">${appName}</a>
                </div>
                <div style="font-size: 10px; color: #cbd5e0; letter-spacing: 0.5px;">
                  ✓ SECURED
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

  // Prepare HTML body (always use HTML format with fancy header)
  let htmlBody: string;

  if (mail?.html) {
    // Original email is HTML
    htmlBody = htmlHeader + mail.html;
  } else if (mail?.text) {
    // Original email is plain text - convert to HTML
    htmlBody =
      htmlHeader +
      `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(mail.text)}</pre>`;
  } else {
    // No content
    htmlBody = htmlHeader + '<p>(No content)</p>';
  }
  return htmlBody;
}
