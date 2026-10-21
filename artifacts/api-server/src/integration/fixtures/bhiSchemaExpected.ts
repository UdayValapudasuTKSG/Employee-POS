// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// The structure the SC-001 test (bhiSchema.test.ts) requires of schema "bhi":
// the 11 BHI Enrollment Database tables the application uses, plus deviations D1–D3.

export interface ExpectedColumn {
  name: string;
  dataType: string;
  charMaxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  nullable: boolean;
  identity: boolean;
}

export interface ExpectedTable {
  columns: ExpectedColumn[];
  primaryKey: string[];
  unique: { name: string; columns: string[]; nullsNotDistinct: boolean }[];
  foreignKeys: {
    name: string;
    column: string;
    refTable: string;
    refColumn: string;
    onUpdate: "CASCADE" | "RESTRICT";
    onDelete: "CASCADE" | "RESTRICT";
  }[];
}

export const EXPECTED_TABLES: Record<string, ExpectedTable> = {
  "company": {
    "columns": [
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_name",
        "dataType": "character varying",
        "charMaxLength": 120,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "address1",
        "dataType": "character varying",
        "charMaxLength": 120,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "address2",
        "dataType": "character varying",
        "charMaxLength": 120,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "city",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "contact_name",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "contact_phone",
        "dataType": "character varying",
        "charMaxLength": 50,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "contact_email",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "updated_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "company_number"
    ],
    "unique": [],
    "foreignKeys": []
  },
  "class": {
    "columns": [
      {
        "name": "class_code",
        "dataType": "character varying",
        "charMaxLength": 1,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "class_name",
        "dataType": "character varying",
        "charMaxLength": 50,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "description",
        "dataType": "character varying",
        "charMaxLength": 255,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "sort_order",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "class_code"
    ],
    "unique": [],
    "foreignKeys": []
  },
  "member": {
    "columns": [
      {
        "name": "member_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "id_type",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "id_number",
        "dataType": "character varying",
        "charMaxLength": 40,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "last_name",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "first_name",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "middle_initials",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "date_of_birth",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "sex",
        "dataType": "character varying",
        "charMaxLength": 10,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "class_code",
        "dataType": "character varying",
        "charMaxLength": 1,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "address_line1",
        "dataType": "character varying",
        "charMaxLength": 150,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "address_line2",
        "dataType": "character varying",
        "charMaxLength": 150,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "phone",
        "dataType": "character varying",
        "charMaxLength": 50,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "email",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "employment_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "plan_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "rate_of_pay",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": true,
        "identity": false
      },
      {
        "name": "occupation",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "inactive_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "inactive_reason",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "updated_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "member_id"
    ],
    "unique": [
      {
        "name": "member_id_type_id_number_uq",
        "columns": [
          "id_type",
          "id_number"
        ],
        "nullsNotDistinct": false
      }
    ],
    "foreignKeys": [
      {
        "name": "member_company_fk",
        "column": "company_number",
        "refTable": "company",
        "refColumn": "company_number",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      },
      {
        "name": "member_class_fk",
        "column": "class_code",
        "refTable": "class",
        "refColumn": "class_code",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      }
    ]
  },
  "dependent": {
    "columns": [
      {
        "name": "dependent_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "member_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "id_type",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "id_number",
        "dataType": "character varying",
        "charMaxLength": 40,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "dependent_full_name",
        "dataType": "character varying",
        "charMaxLength": 120,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "date_of_birth",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "sex",
        "dataType": "character varying",
        "charMaxLength": 10,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "relationship",
        "dataType": "character varying",
        "charMaxLength": 30,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "inactive_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "inactive_reason",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "updated_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "dependent_id"
    ],
    "unique": [],
    "foreignKeys": [
      {
        "name": "dependent_member_fk",
        "column": "member_id",
        "refTable": "member",
        "refColumn": "member_id",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      }
    ]
  },
  "beneficiary": {
    "columns": [
      {
        "name": "beneficiary_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "member_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "id_type",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "id_number",
        "dataType": "character varying",
        "charMaxLength": 40,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "beneficiary_full_name",
        "dataType": "character varying",
        "charMaxLength": 120,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "date_of_birth",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "sex",
        "dataType": "character varying",
        "charMaxLength": 10,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "relationship",
        "dataType": "character varying",
        "charMaxLength": 30,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "phone",
        "dataType": "character varying",
        "charMaxLength": 50,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "email",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "share_percent",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "inactive_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "inactive_reason",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "updated_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "beneficiary_id"
    ],
    "unique": [],
    "foreignKeys": [
      {
        "name": "beneficiary_member_fk",
        "column": "member_id",
        "refTable": "member",
        "refColumn": "member_id",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      }
    ]
  },
  "premium_rates": {
    "columns": [
      {
        "name": "premium_rate_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "class_code",
        "dataType": "character varying",
        "charMaxLength": 1,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "coverage_band",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "coverage_label",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "dependent_band",
        "dataType": "smallint",
        "charMaxLength": null,
        "numericPrecision": 16,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "total_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "employee_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "effective_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "premium_rate_id"
    ],
    "unique": [
      {
        "name": "premium_rates_company_class_band_date_uq",
        "columns": [
          "company_number",
          "class_code",
          "coverage_band",
          "effective_date"
        ],
        "nullsNotDistinct": true
      }
    ],
    "foreignKeys": [
      {
        "name": "premium_rates_class_fk",
        "column": "class_code",
        "refTable": "class",
        "refColumn": "class_code",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      },
      {
        "name": "premium_rates_company_fk",
        "column": "company_number",
        "refTable": "company",
        "refColumn": "company_number",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      }
    ]
  },
  "billing_run": {
    "columns": [
      {
        "name": "billing_run_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "billing_month",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "billing_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "generated_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "generated_by",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "status",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "billing_run_id"
    ],
    "unique": [],
    "foreignKeys": [
      {
        "name": "billing_run_company_fk",
        "column": "company_number",
        "refTable": "company",
        "refColumn": "company_number",
        "onUpdate": "CASCADE",
        "onDelete": "RESTRICT"
      }
    ]
  },
  "billing_line": {
    "columns": [
      {
        "name": "billing_line_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "billing_run_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "member_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "id_type",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "id_number",
        "dataType": "character varying",
        "charMaxLength": 40,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "member_name",
        "dataType": "character varying",
        "charMaxLength": 180,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "class_code",
        "dataType": "character varying",
        "charMaxLength": 1,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "active_dependent_count",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "coverage_band",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "coverage_label",
        "dataType": "character varying",
        "charMaxLength": 80,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "total_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "employee_premium",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": 15,
        "numericScale": 2,
        "nullable": false,
        "identity": false
      },
      {
        "name": "rate_effective_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "premium_rate_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "billing_line_id"
    ],
    "unique": [],
    "foreignKeys": [
      {
        "name": "billing_line_run_fk",
        "column": "billing_run_id",
        "refTable": "billing_run",
        "refColumn": "billing_run_id",
        "onUpdate": "CASCADE",
        "onDelete": "CASCADE"
      }
    ]
  },
  "company_billing_rule": {
    "columns": [
      {
        "name": "company_billing_rule_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "company_share_percent",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "employee_share_percent",
        "dataType": "numeric",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "effective_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "company_billing_rule_id"
    ],
    "unique": [
      {
        "name": "company_billing_rule_company_date_uq",
        "columns": [
          "company_number",
          "effective_date"
        ],
        "nullsNotDistinct": false
      }
    ],
    "foreignKeys": []
  },
  "enrollment_status_history": {
    "columns": [
      {
        "name": "status_history_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "entity_type",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "entity_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": false
      },
      {
        "name": "member_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": true,
        "identity": false
      },
      {
        "name": "company_number",
        "dataType": "character varying",
        "charMaxLength": 20,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "person_identifier",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "person_name",
        "dataType": "character varying",
        "charMaxLength": 180,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "old_active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "new_active",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "effective_date",
        "dataType": "date",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "reason",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "cascade_applied",
        "dataType": "boolean",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": false,
        "identity": false
      },
      {
        "name": "related_records_changed",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": true,
        "identity": false
      },
      {
        "name": "changed_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "changed_by",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "notes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "status_history_id"
    ],
    "unique": [],
    "foreignKeys": []
  },
  "import_exception": {
    "columns": [
      {
        "name": "exception_id",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": false,
        "identity": true
      },
      {
        "name": "source_alias",
        "dataType": "character varying",
        "charMaxLength": 255,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "source_file",
        "dataType": "character varying",
        "charMaxLength": 255,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "source_path",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "sheet_name",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "excel_row",
        "dataType": "integer",
        "charMaxLength": null,
        "numericPrecision": 32,
        "numericScale": 0,
        "nullable": true,
        "identity": false
      },
      {
        "name": "cell_or_range",
        "dataType": "character varying",
        "charMaxLength": 255,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "entity_type",
        "dataType": "character varying",
        "charMaxLength": 30,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "person_name",
        "dataType": "character varying",
        "charMaxLength": 255,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "member_identifier",
        "dataType": "character varying",
        "charMaxLength": 100,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "reason_codes",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "reason",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "required_action",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "raw_row_summary",
        "dataType": "text",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      },
      {
        "name": "created_at",
        "dataType": "timestamp with time zone",
        "charMaxLength": null,
        "numericPrecision": null,
        "numericScale": null,
        "nullable": true,
        "identity": false
      }
    ],
    "primaryKey": [
      "exception_id"
    ],
    "unique": [],
    "foreignKeys": []
  }
};

/** Secondary indexes (not the ones backing a primary or unique key). */
export const EXPECTED_INDEXES: { name: string; table: string; columns: string[] }[] = [
  {
    "name": "company_active_idx",
    "table": "company",
    "columns": [
      "active"
    ]
  },
  {
    "name": "member_active_idx",
    "table": "member",
    "columns": [
      "active"
    ]
  },
  {
    "name": "member_class_code_idx",
    "table": "member",
    "columns": [
      "class_code"
    ]
  },
  {
    "name": "member_company_number_idx",
    "table": "member",
    "columns": [
      "company_number"
    ]
  },
  {
    "name": "dependent_active_idx",
    "table": "dependent",
    "columns": [
      "active"
    ]
  },
  {
    "name": "dependent_id_type_id_number_idx",
    "table": "dependent",
    "columns": [
      "id_type",
      "id_number"
    ]
  },
  {
    "name": "dependent_member_id_idx",
    "table": "dependent",
    "columns": [
      "member_id"
    ]
  },
  {
    "name": "beneficiary_active_idx",
    "table": "beneficiary",
    "columns": [
      "active"
    ]
  },
  {
    "name": "beneficiary_id_type_id_number_idx",
    "table": "beneficiary",
    "columns": [
      "id_type",
      "id_number"
    ]
  },
  {
    "name": "beneficiary_member_id_idx",
    "table": "beneficiary",
    "columns": [
      "member_id"
    ]
  },
  {
    "name": "premium_rates_active_idx",
    "table": "premium_rates",
    "columns": [
      "active"
    ]
  },
  {
    "name": "billing_run_company_month_idx",
    "table": "billing_run",
    "columns": [
      "company_number",
      "billing_month"
    ]
  },
  {
    "name": "billing_line_id_type_id_number_idx",
    "table": "billing_line",
    "columns": [
      "id_type",
      "id_number"
    ]
  },
  {
    "name": "billing_line_member_id_idx",
    "table": "billing_line",
    "columns": [
      "member_id"
    ]
  },
  {
    "name": "billing_line_billing_run_id_idx",
    "table": "billing_line",
    "columns": [
      "billing_run_id"
    ]
  },
  {
    "name": "enrollment_status_history_effective_date_idx",
    "table": "enrollment_status_history",
    "columns": [
      "effective_date"
    ]
  },
  {
    "name": "enrollment_status_history_entity_idx",
    "table": "enrollment_status_history",
    "columns": [
      "entity_type",
      "entity_id"
    ]
  },
  {
    "name": "enrollment_status_history_member_id_idx",
    "table": "enrollment_status_history",
    "columns": [
      "member_id"
    ]
  },
  {
    "name": "import_exception_source_idx",
    "table": "import_exception",
    "columns": [
      "source_file",
      "sheet_name",
      "excel_row"
    ]
  }
];
