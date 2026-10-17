import { readFile, writeFile } from "node:fs/promises";
import webpush from "web-push";
const path = ".env.local";
let content = await readFile(path,"utf8");
if (!/^APP_ENV=development\s*$/m.test(content)) throw new Error("Solo configuración local DEV existente");
if (/^VAPID_PRIVATE_KEY=\S+/m.test(content)) {
  console.log("Se conserva configuración VAPID local existente.");
} else {
  const keys=webpush.generateVAPIDKeys();
  for (const [name,value] of Object.entries({ VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:"mailto:local@localhost" })) {
    const regex=new RegExp(`^${name}=.*$`,"m");
    content=regex.test(content) ? content.replace(regex,`${name}=${value}`) : `${content}\n${name}=${value}\n`;
  }
  await writeFile(path,content,{mode:0o600});
  console.log("Claves DEV generadas en .env.local ignorado por Git; no se muestran secretos. Reiniciar DEV para cargarlas.");
}
