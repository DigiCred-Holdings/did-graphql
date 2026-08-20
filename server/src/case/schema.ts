export const CASE_TYPEDEFS = /* GraphQL */ `
  """Arbitrary JSON — used for CFItem.extensions, which the CASE 1.1 spec defines as free-form per framework (namespace conventions like ext:ctdl are a consumer's own choice, not part of the spec proper)."""
  scalar JSON

  """A reference to another CASE resource — identifier + title + uri."""
  type CFURIReference {
    identifier: ID!
    title: String
    uri: String
  }

  """The root framework-metadata object for one CASE package — see go-case's GET /ims/case/v1p1/CFDocuments{,/:id}."""
  type CFDocument {
    identifier: ID!
    uri: String
    title: String!
    creator: String
    publisher: String
    description: String
    subject: [String!]
    language: String
    version: String
    adoptionStatus: String
    statusStartDate: String
    statusEndDate: String
    officialSourceURL: String
    notes: String
    frameworkType: String
    caseVersion: String
    lastChangeDateTime: String
    CFPackageURI: CFURIReference
  }

  type CFDocumentResults {
    items: [CFDocument!]!
    """Total frameworks on the server, before limit/offset slicing — go-case's own X-Total-Count header."""
    totalCount: Int!
  }

  """One CFItemType found within a framework, and how many items use it — see Query.cfItemTypes."""
  type CFItemTypeCount {
    itemType: String!
    count: Int!
  }

  """One competency/standard/node within a framework — the raw CASE item."""
  type CFItem {
    identifier: ID!
    uri: String
    CFItemType: String!
    CFItemTypeURI: CFURIReference
    fullStatement: String
    abbreviatedStatement: String
    humanCodingScheme: String
    alternativeLabel: String
    listEnumeration: String
    conceptKeywords: [String!]
    conceptKeywordsURI: [CFURIReference!]
    notes: String
    language: String
    educationLevel: [String!]
    subject: [String!]
    subjectURI: [CFURIReference!]
    statusStartDate: String
    statusEndDate: String
    licenseURI: CFURIReference
    lastChangeDateTime: String
    CFDocumentURI: CFURIReference
    """Free-form extension payload — arbitrary per framework, namespace keys are a consumer's own convention (see the JSON scalar's own doc comment)."""
    extensions: JSON
  }

  type CFItemResults {
    items: [CFItem!]!
    """Total items in the framework, before limit/offset slicing — see Query.cfItems."""
    totalCount: Int!
  }

  """A single directed edge between two CFItems within a framework (e.g. isChildOf, isRelatedTo)."""
  type CFAssociation {
    identifier: ID!
    uri: String
    associationType: String!
    lastChangeDateTime: String
    CFDocumentURI: CFURIReference
    originNodeURI: CFURIReference!
    destinationNodeURI: CFURIReference!
  }

  """A full CASE framework: metadata plus every item and association. go-case's /CFPackages/{id} has no pagination."""
  type CFPackage {
    CFDocument: CFDocument!
    CFItems: [CFItem!]!
    CFAssociations: [CFAssociation!]!
  }
`

export const CASE_QUERY_FIELDS = /* GraphQL */ `
    """Every framework hosted on the go-case server. Uses go-case's own real limit/offset pagination."""
    cfDocuments(limit: Int, offset: Int): CFDocumentResults!
    """A single framework's own metadata by id, from any package on the server."""
    cfDocument(id: ID!): CFDocument
    """A full CASE package (framework metadata + every item + every association) by id."""
    cfPackage(id: ID!): CFPackage
    """A single CFItem (competency/standard/node) by id, from any framework on the server."""
    cfItem(id: ID!): CFItem
    """Every distinct CFItemType within one framework, with how many items use each — sorted by count, most common first. packageId/framework: framework by title, packageId by exact id, packageId wins if both given."""
    cfItemTypes(packageId: ID, framework: String): [CFItemTypeCount!]!
    """Every CFItem within one framework, paginated — unlike cfPackage this returns only items with real limit/offset slicing. itemType filters to one CFItemType (see cfItemTypes to discover which values exist first); totalCount reflects the filtered count, not the whole framework."""
    cfItems(packageId: ID, framework: String, itemType: String, limit: Int, offset: Int): CFItemResults!
`

export const CASE_DEFAULT_QUERIES = [
  'query CFDocuments($limit: Int, $offset: Int) { cfDocuments(limit: $limit, offset: $offset) { items { identifier title description frameworkType publisher version } totalCount } }',
  'query CFDocument($id: ID!) { cfDocument(id: $id) { identifier uri title creator publisher description subject language version frameworkType caseVersion lastChangeDateTime } }',
  'query CFPackage($id: ID!) { cfPackage(id: $id) { CFDocument { identifier title frameworkType } CFItems { identifier CFItemType fullStatement abbreviatedStatement } CFAssociations { identifier associationType originNodeURI { identifier title } destinationNodeURI { identifier title } } } }',
  'query CFItem($id: ID!) { cfItem(id: $id) { identifier uri CFItemType fullStatement abbreviatedStatement subject extensions } }',
  'query CFItemTypes($packageId: ID, $framework: String) { cfItemTypes(packageId: $packageId, framework: $framework) { itemType count } }',
  'query CFItems($packageId: ID, $framework: String, $itemType: String, $limit: Int, $offset: Int) { cfItems(packageId: $packageId, framework: $framework, itemType: $itemType, limit: $limit, offset: $offset) { items { identifier CFItemType fullStatement abbreviatedStatement } totalCount } }',
]
