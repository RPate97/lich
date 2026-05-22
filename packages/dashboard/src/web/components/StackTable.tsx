import {
  type ColumnDef, flexRender, getCoreRowModel, useReactTable,
} from '@tanstack/react-table';
import { Badge } from './ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from './ui/table';
import type { StackView } from '../../types';

const STATUS_VARIANT: Record<StackView['status'], string> = {
  running: 'default',
  partial: 'secondary',
  down: 'destructive',
};

const columns: ColumnDef<StackView>[] = [
  {
    header: 'Branch',
    accessorKey: 'branch',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.branch}</div>
        <div className="text-muted-foreground text-xs">{row.original.path}</div>
      </div>
    ),
  },
  {
    header: 'Status',
    accessorKey: 'status',
    cell: ({ row }) => (
      <Badge variant={STATUS_VARIANT[row.original.status] as never}>
        {row.original.status}
        {row.original.worktreeMissing ? ' · worktree missing' : ''}
      </Badge>
    ),
  },
  {
    header: 'Services',
    cell: ({ row }) => {
      const up = row.original.services.filter((s) => s.status === 'up').length;
      return `${up}/${row.original.services.length} up`;
    },
  },
];

export function StackTable({
  stacks,
  onSelect,
}: {
  stacks: StackView[];
  onSelect: (s: StackView) => void;
}) {
  const table = useReactTable({
    data: stacks,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((h) => (
              <TableHead key={h.id}>
                {flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="text-muted-foreground text-center">
              No stacks running — run <code>lich up</code>.
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => onSelect(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
