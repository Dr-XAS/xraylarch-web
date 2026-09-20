import Image from "next/image"
import { appUrl } from "@/lib/app-url"
import styles from "./drxas-logo.module.css"

export function DrXasLogo() {
  return <span className={styles.logo} role="img" aria-label="Dr.XAS logo">
    <Image className={styles.light} src={appUrl("/logos/drxas-mark-light.png")} alt="" width={1623} height={1491} sizes="44px" loading="eager" />
    <Image className={styles.dark} src={appUrl("/logos/drxas-mark-dark.png")} alt="" width={1623} height={1491} sizes="44px" loading="eager" />
  </span>
}
