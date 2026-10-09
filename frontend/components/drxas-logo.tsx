import Image from "next/image"
import { appUrl } from "@/lib/app-url"
import styles from "./drxas-logo.module.css"

export function DrXasLogo() {
  return <span className={styles.logo} role="img" aria-label="Dr.XAS logo">
    <Image className={styles.light} src={appUrl("/logos/drxas-wordmark-light.png")} alt="" width={4260} height={1404} sizes="(max-width: 620px) 144px, 176px" loading="eager" />
    <Image className={styles.dark} src={appUrl("/logos/drxas-wordmark-dark.png")} alt="" width={2547} height={843} sizes="(max-width: 620px) 144px, 176px" loading="eager" />
  </span>
}
