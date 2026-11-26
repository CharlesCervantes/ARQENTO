import { Plus_Jakarta_Sans } from "next/font/google";

// Tipografía del diseño de Inicio (Plus Jakarta Sans), compartida con las
// pantallas que usan su mismo estilo (Inicio y Proyectos). El resto de la app
// sigue con Geist. Se aplica junto con la clase `.inicio` (globals.css).
export const fuenteInicio = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inicio",
  display: "swap",
});
