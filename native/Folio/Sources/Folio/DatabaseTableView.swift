import SwiftUI
import Charts
import FolioCore

struct DatabaseTableView: View {
    var table: NoteTable
    var onChange: (NoteTable) -> Void
    var onImport: () -> Void
    var onExport: () -> Void
    @State private var draftColumn = ""
    @State private var newColumnKind: TableColumnKind = .text
    private let titleWidth: CGFloat = 245
    private let cellWidth: CGFloat = 150

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            HStack {
                Picker("View", selection: bind(\.view)) {
                    Label("Table", systemImage: "tablecells").tag(TableViewKind.table)
                    Label("Board", systemImage: "rectangle.split.3x1").tag(TableViewKind.board)
                    Label("Chart", systemImage: "chart.bar").tag(TableViewKind.chart)
                }.pickerStyle(.segmented).frame(maxWidth: 390)
                Spacer()
                Menu {
                    Button("Import Notion CSV…", systemImage: "square.and.arrow.down", action: onImport)
                    Button("Export CSV…", systemImage: "square.and.arrow.up", action: onExport)
                    Divider()
                    Menu("Add property") {
                        ForEach(TableColumnKind.allCases, id: \.self) { kind in
                            Button(kind.title, systemImage: symbol(kind)) { addColumn(kind) }
                        }
                    }
                } label: { Image(systemName: "ellipsis").frame(width: 28, height: 28) }.menuStyle(.borderlessButton).help("Database options")
                Button { addRow() } label: { Label("New", systemImage: "plus") }.buttonStyle(QuietButton(accent: true))
            }
            if table.view == .table { tableView }
            else if table.view == .board { boardView }
            else { chartView }
        }.padding(.top, 3)
    }

    private var tableView: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(table.columns) { column in
                        HStack(spacing: 7) {
                            Image(systemName: symbol(column.kind)).foregroundStyle(Palette.muted)
                            TextField("Property", text: columnBinding(column.id, \DatabaseColumn.name)).textFieldStyle(.plain).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            Menu {
                                ForEach(TableColumnKind.allCases, id: \.self) { kind in Button(kind.title) { updateColumn(column.id) { $0.kind = kind } } }
                                Divider(); Button("Delete property", role: .destructive) { removeColumn(column.id) }
                            } label: { Image(systemName: "ellipsis").font(.system(size: 10)).foregroundStyle(Palette.muted) }.menuStyle(.borderlessButton).frame(width: 17)
                        }.padding(.horizontal, 11).frame(width: column.kind == .title ? titleWidth : cellWidth, height: 40, alignment: .leading)
                            .overlay(alignment: .trailing) { Rectangle().fill(Palette.line).frame(width: 1) }
                    }
                    Button { addColumn(.text) } label: { Image(systemName: "plus").foregroundStyle(Palette.muted).frame(width: 42, height: 40) }.buttonStyle(.plain).help("Add property")
                }.background(Palette.raised.opacity(0.6))
                ForEach(table.rows) { row in
                    HStack(spacing: 0) {
                        ForEach(table.columns) { column in cell(row, column) }
                        Button(role: .destructive) { removeRow(row.id) } label: { Image(systemName: "minus.circle").foregroundStyle(Palette.muted.opacity(0.7)).frame(width: 42, height: 44) }.buttonStyle(.plain).help("Delete row")
                    }.overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
                }
                Button { addRow() } label: { Label("New page", systemImage: "plus").font(.system(size: 11)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(12) }.buttonStyle(.plain)
                if table.rows.isEmpty { emptyImport }
            }
        }.frame(minHeight: 255).background(Palette.canvas.opacity(0.4), in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line, lineWidth: 1))
    }

    @ViewBuilder private func cell(_ row: DatabaseRow, _ column: DatabaseColumn) -> some View {
        let value = row.values[column.id, default: ""]
        Group {
            if column.kind == .select || column.kind == .status {
                Menu {
                    ForEach(column.options, id: \.self) { option in Button(option) { setValue(row.id, column.id, option) } }
                    Divider(); Button("Clear") { setValue(row.id, column.id, "") }
                } label: {
                    HStack(spacing: 6) { if !value.isEmpty { Circle().fill(valueColor(value)).frame(width: 6, height: 6) }; Text(value.isEmpty ? "Choose…" : value).lineLimit(1).foregroundStyle(value.isEmpty ? Palette.muted : Palette.text); Spacer(minLength: 0); Image(systemName: "chevron.down").font(.system(size: 8)).foregroundStyle(Palette.muted) }
                        .padding(.horizontal, 8).padding(.vertical, 5).background(value.isEmpty ? Color.clear : valueColor(value).opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
                }.menuStyle(.borderlessButton)
            } else if column.kind == .rating {
                Menu {
                    ForEach(1...5, id: \.self) { rating in Button(String(repeating: "★", count: rating)) { setValue(row.id, column.id, "\(rating)") } }
                    Button("Clear") { setValue(row.id, column.id, "") }
                } label: { Text(value.isEmpty ? "☆☆☆☆☆" : String(repeating: "★", count: min(5, Int(value) ?? 0))).foregroundStyle(value.isEmpty ? Palette.muted : .orange).frame(maxWidth: .infinity, alignment: .leading) }.menuStyle(.borderlessButton)
            } else {
                TextField(column.name, text: valueBinding(row.id, column.id)).textFieldStyle(.plain).font(.system(size: 12)).foregroundStyle(Palette.text)
                    .onSubmit { if column.kind == .title { addRowIfLast(row.id) } }
            }
        }.padding(.horizontal, 11).frame(width: column.kind == .title ? titleWidth : cellWidth, height: 44, alignment: .leading)
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.line).frame(width: 1) }
    }

    private var boardView: some View {
        let column = table.columns.first(where: { $0.id == table.groupBy }) ?? table.columns.first(where: { $0.kind == .status || $0.kind == .select })
        let title = table.columns.first(where: { $0.kind == .title })
        let titleID = title?.id ?? ""
        let authorColumn = table.columns.first(where: { $0.name.localizedCaseInsensitiveContains("author") })
        let groups = column.map { col in Array(Set(col.options + table.rows.compactMap { $0.values[col.id].flatMap { $0.isEmpty ? nil : $0 } })).sorted() } ?? ["All"]
        return VStack(alignment: .leading, spacing: 10) {
            HStack { Text("Group by").font(.system(size: 11)).foregroundStyle(Palette.muted); Picker("Group by", selection: Binding(get: { table.groupBy ?? column?.id ?? "" }, set: { value in var next = table; next.groupBy = value; onChange(next) })) { ForEach(table.columns.filter { $0.kind == .status || $0.kind == .select }) { Text($0.name).tag($0.id) } }.labelsHidden().frame(width: 155) }
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(groups, id: \.self) { group in
                        let groupRows = table.rows.filter { ($0.values[column?.id ?? ""] ?? "") == group }
                        VStack(alignment: .leading, spacing: 8) {
                            laneHeader(group, count: groupRows.count).padding(.bottom, 3)
                            ForEach(groupRows) { row in boardCard(row, titleID: titleID, authorColumn: authorColumn) }
                            if let groupColumn = column?.id { Button { addRow(group: group, groupColumn: groupColumn) } label: { Label("Add page", systemImage: "plus").font(.system(size: 10)).foregroundStyle(Palette.muted) }.buttonStyle(.plain) }
                        }.padding(12).frame(width: 235, alignment: .topLeading).background(Palette.canvas.opacity(0.5), in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line, lineWidth: 1))
                    }
                    Button { addRow() } label: { Label("New group", systemImage: "plus").font(.system(size: 11)).foregroundStyle(Palette.muted).padding(14) }.buttonStyle(.plain)
                }.padding(.vertical, 6)
            }
        }.frame(maxWidth: .infinity, minHeight: 310, alignment: .topLeading)
    }

    private var chartView: some View {
        let category = table.columns.first(where: { $0.id == table.chartBy }) ?? table.columns.first(where: { $0.kind == .status || $0.kind == .select })
        let counts = category.map { col in Dictionary(grouping: table.rows, by: { $0.values[col.id].flatMap { $0.isEmpty ? nil : $0 } ?? "Not set" }).map { (name: $0.key, count: $0.value.count) }.sorted { $0.count > $1.count } } ?? []
        return VStack(alignment: .leading, spacing: 17) {
            HStack { Label("Count by", systemImage: "chart.bar").font(.system(size: 12)).foregroundStyle(Palette.muted); Picker("Chart property", selection: Binding(get: { table.chartBy ?? category?.id ?? "" }, set: { value in var next = table; next.chartBy = value; onChange(next) })) { ForEach(table.columns.filter { $0.kind == .status || $0.kind == .select || $0.kind == .text }) { Text($0.name).tag($0.id) } }.labelsHidden().frame(width: 170) }
            if table.rows.isEmpty { emptyImport }
            else if !counts.isEmpty {
                Chart(counts, id: \.name) { item in
                    BarMark(x: .value("Category", item.name), y: .value("Pages", item.count)).foregroundStyle(valueColor(item.name).gradient).annotation(position: .top) { Text("\(item.count)").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted) }
                }.chartLegend(.hidden).chartYAxis { AxisMarks(position: .leading) }.frame(height: 250).padding(.horizontal, 8)
                Text("\(table.rows.count) items · grouped by \(category?.name ?? "property")").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
        }.frame(maxWidth: .infinity, minHeight: 310, alignment: .topLeading).padding(16).background(Palette.raised.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
    }

    private func boardCard(_ row: DatabaseRow, titleID: String, authorColumn: DatabaseColumn?) -> some View {
        let title = row.values[titleID, default: "Untitled"]
        let author = authorColumn.map { row.values[$0.id, default: ""] } ?? ""
        return VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 12, weight: .medium)).lineLimit(2)
            if !author.isEmpty { Text(author).font(.system(size: 10)).foregroundStyle(Palette.muted) }
        }.padding(11).frame(maxWidth: .infinity, alignment: .leading).background(Palette.raised.opacity(0.48), in: RoundedRectangle(cornerRadius: 7))
    }
    private func laneHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 8) {
            Circle().fill(valueColor(title)).frame(width: 7, height: 7)
            Text(title).font(.system(size: 12, weight: .semibold))
            Text(String(count)).font(.system(size: 10)).foregroundStyle(Palette.muted)
        }
    }

    private var emptyImport: some View {
        VStack(spacing: 9) {
            Image(systemName: "books.vertical").font(.system(size: 25, weight: .light)).foregroundStyle(Palette.mint)
            Text("Your library starts here").font(.system(size: 16, weight: .medium, design: .serif))
            Text("Import a CSV exported from Notion, or add your books row by row. Your rows stay on this Mac.").font(.system(size: 11)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).frame(maxWidth: 400)
            Button("Import Notion CSV…", action: onImport).buttonStyle(QuietButton(accent: true)).padding(.top, 3)
        }.frame(maxWidth: .infinity).padding(.vertical, 30)
    }

    private func bind<Value>(_ keyPath: WritableKeyPath<NoteTable, Value>) -> Binding<Value> { Binding(get: { table[keyPath: keyPath] }, set: { value in var next = table; next[keyPath: keyPath] = value; onChange(next) }) }
    private func columnBinding(_ id: String, _ keyPath: WritableKeyPath<DatabaseColumn, String>) -> Binding<String> { Binding(get: { table.columns.first(where: { $0.id == id })?[keyPath: keyPath] ?? "" }, set: { value in updateColumn(id) { $0[keyPath: keyPath] = value } }) }
    private func valueBinding(_ row: String, _ column: String) -> Binding<String> { Binding(get: { table.rows.first(where: { $0.id == row })?.values[column, default: ""] ?? "" }, set: { setValue(row, column, $0) }) }
    private func setValue(_ rowID: String, _ columnID: String, _ value: String) { var next = table; guard let index = next.rows.firstIndex(where: { $0.id == rowID }) else { return }; next.rows[index].values[columnID] = value; onChange(next) }
    private func updateColumn(_ id: String, _ change: (inout DatabaseColumn) -> Void) { var next = table; guard let index = next.columns.firstIndex(where: { $0.id == id }) else { return }; change(&next.columns[index]); onChange(next) }
    private func removeColumn(_ id: String) { var next = table; next.columns.removeAll { $0.id == id }; next.rows.indices.forEach { next.rows[$0].values.removeValue(forKey: id) }; onChange(next) }
    private func addColumn(_ kind: TableColumnKind) { var next = table; next.columns.append(DatabaseColumn(name: kind.title, kind: kind, options: kind == .status ? ["To read", "Reading", "Done"] : [])); next.rows.indices.forEach { next.rows[$0].values[next.columns.last!.id] = "" }; onChange(next) }
    private func addRow(group: String, groupColumn: String) { var next = table; var row = DatabaseRow(); row.values[groupColumn] = group; next.rows.append(row); onChange(next) }
    private func addRow() { var next = table; next.rows.append(DatabaseRow()); onChange(next) }
    private func addRowIfLast(_ id: String) { if table.rows.last?.id == id { addRow() } }
    private func removeRow(_ id: String) { var next = table; next.rows.removeAll { $0.id == id }; onChange(next) }
    private func symbol(_ kind: TableColumnKind) -> String { switch kind { case .title: "doc.text"; case .text: "text.alignleft"; case .select: "list.bullet"; case .status: "circle.dotted"; case .number: "number"; case .date: "calendar"; case .rating: "star"; case .multiSelect: "list.bullet.indent"; case .checkbox: "checkmark.square"; case .url: "link" } }
    private func valueColor(_ text: String) -> Color {
        switch text.lowercased() { case "done", "fiction", "green": Palette.mint; case "reading", "poetry", "yellow": .yellow; case "to read", "philosophy", "blue": .blue; case "biography", "orange": .orange; case "history", "pink": .pink; default: Palette.muted }
    }
}
