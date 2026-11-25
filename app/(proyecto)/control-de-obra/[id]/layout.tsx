import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/server/auth/dal";
import {
  esMaster,
  puedeVerContratoGeneralPrivado,
  puedeAdministrarProyectos,
} from "@/lib/server/permisos";
import { NOMBRE_ROL } from "@/lib/roles";
import {
  obtenerProyecto,
  ProyectoNoEncontradoError,
} from "@/lib/server/control-de-obra/proyectos";
import { hayAvancePendiente } from "@/lib/server/control-de-obra/avance";
import { hayPropuestasPendientes } from "@/lib/server/control-de-obra/propuestas-contrato";
import { hayGastosPendientesRevision } from "@/lib/server/control-de-obra/gastos";
import { DirtyAvanceProvider } from "@/components/control-de-obra/dirty-avance-context";
import { AppShell } from "@/app/(app)/_components/app-shell";
import { Sidebar } from "@/app/(app)/_components/sidebar";

export default async function ProyectoLayout({
  children,
  params,
}: LayoutProps<"/control-de-obra/[id]">) {
  const usuario = await requireSession();
  const { id } = await params;

  if (usuario.debeCambiarPassword) redirect("/nueva-password");
  if (esMaster(usuario)) redirect("/master");

  let proyecto;
  try {
    proyecto = await obtenerProyecto(usuario, id);
  } catch (error) {
    if (error instanceof ProyectoNoEncontradoError) notFound();
    throw error;
  }

  // Mismo criterio ya usado hoy en contrato/layout.tsx y cliente/layout.tsx
  // (antes de moverse al sidebar): un solo helper centralizado decide si
  // "Privado"/"Cliente Priv." aparecen — el gate real de datos sigue viviendo
  // en cada página, esto solo controla visibilidad de navegación (rediseño
  // de navegación, agosto 2026).
  const puedeVerPrivado = puedeVerContratoGeneralPrivado(usuario);

  // Puntito de "algo pendiente" junto a Avance de obra/Gastos — mismo
  // criterio que en el sidebar global (solo quien puede aprobar).
  const puedeVerAlertas = puedeAdministrarProyectos(usuario);
  const [avancePendiente, gastosPendientes, propuestasPendientes] = puedeVerAlertas
    ? await Promise.all([hayAvancePendiente(id), hayGastosPendientesRevision(id), hayPropuestasPendientes({ proyectoId: id })])
    : [false, false, false];

  const grupos = [
    {
      label: "Contrato",
      hrefActivo: `/control-de-obra/${id}/contrato`,
      hijos: [
        { href: `/control-de-obra/${id}/contrato/general`, label: "General", pendiente: propuestasPendientes },
        ...(puedeVerPrivado
          ? [{ href: `/control-de-obra/${id}/contrato/privado`, label: "Privado" }]
          : []),
      ],
    },
    {
      label: "Ejecución",
      hrefActivo: `/control-de-obra/${id}/ejecucion`,
      // Sin gating por permiso — igual que hoy, Supervisor ve las tres; el
      // filtrado real ocurre dentro de cada página.
      hijos: [
        {
          href: `/control-de-obra/${id}/ejecucion/avance`,
          label: "Avance de obra",
          pendiente: avancePendiente,
        },
        { href: `/control-de-obra/${id}/ejecucion/contratistas`, label: "Contratistas" },
        {
          href: `/control-de-obra/${id}/ejecucion/gastos`,
          label: "Gastos",
          coincideSubrutas: true,
          pendiente: gastosPendientes,
        },
      ],
    },
    {
      label: "Cliente",
      hrefActivo: `/control-de-obra/${id}/cliente`,
      hijos: [
        {
          href: `/control-de-obra/${id}/cliente/general`,
          label: "Cliente",
          coincideSubrutas: true,
        },
        ...(puedeVerPrivado
          ? [
              {
                href: `/control-de-obra/${id}/cliente/privado`,
                label: "Cliente Priv.",
                coincideSubrutas: true,
              },
            ]
          : []),
      ],
    },
  ];

  // El bucket de almacenamiento es privado — nunca se usa logoRef
  // directamente como <img src>, siempre a través del endpoint autenticado
  // (ver app/api/empresas/[id]/logo).
  const logoUrl = usuario.empresa?.logoRef
    ? `/api/empresas/${usuario.empresa.id}/logo`
    : null;

  return (
    <DirtyAvanceProvider>
      <AppShell
        usuario={usuario}
        sidebar={
          <Sidebar
            variant="proyecto"
            empresaNombre={usuario.empresa?.nombre ?? "Conkuali"}
            logoUrl={logoUrl}
            usuarioNombre={usuario.nombre}
            rolLabel={NOMBRE_ROL[usuario.rol] ?? usuario.rol}
            proyecto={{ id, nombre: proyecto.nombre, estatus: proyecto.estatus }}
            resumenHref={`/control-de-obra/${id}`}
            grupos={grupos}
          />
        }
      >
        {children}
      </AppShell>
    </DirtyAvanceProvider>
  );
}
