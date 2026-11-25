-- Gasto cobrable solo en la estimación privada. Aditiva: agrega un valor al
-- tipo; ningún gasto u orden de compra existente cambia.
ALTER TYPE "TratamientoClienteGasto" ADD VALUE 'COBRABLE_SOLO_PRIVADO' BEFORE 'NO_COBRABLE';
